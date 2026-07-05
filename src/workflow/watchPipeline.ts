/**
 * Stage 12: poll the MR/PR's pipeline (at config.pollIntervalSeconds) until it
 * succeeds; on failure, hand the pipeline id/URL to the configured agent and
 * let it pull the failed jobs and logs itself via whatever forge MCP tooling
 * is available (pipeline-worker's own, or an external GitLab/GitHub MCP
 * server the agent already has configured), then commit the fix, push, and
 * retry — capped at config.maxFixAttempts before escalating via an MR
 * comment. Never retries indefinitely, and never spends agent tokens on
 * pipelines that are not actually failed (canceled/skipped go straight to a
 * human).
 *
 * Also watches for the forge confirming a real merge conflict against the
 * target branch (GitHub's "dirty" / GitLab's "cannot_be_merged") — some
 * repos never even run CI on an unmergeable PR, so this is checked on every
 * poll interval rather than only after a pipeline goes terminal. When found,
 * merges the target branch in and asks the agent to resolve any actual
 * conflict markers, sharing the same maxFixAttempts budget as CI fixes.
 *
 * If no pipeline shows up for the MR/PR at all within a short grace window
 * AND the worktree has no CI config file (.gitlab-ci.yml / .github/workflows),
 * the run ends there instead of polling for up to the full 2-hour safety
 * window. A repo that does have a CI config file always gets the full
 * window — its pipeline may just be slow to register.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentInvokeResult } from '../agent/types.js';
import { stageAll, commit, push, hasChanges, listConflictedFiles, findUnresolvedConflictMarkers } from '../git/commit.js';
import type { ForgeClient } from '../forge/types.js';
import { recordEvent } from '../state/runState.js';
import { step, runStep, note, reportAgentInvocation } from '../ui/steps.js';
import type { ForgeName, PipelineWorkerConfig, Pipeline, RunState } from '../types.js';

const execFileAsync = promisify(execFile);

const MAX_POLL_WINDOW_MS = 2 * 60 * 60 * 1000; // per pipeline attempt, as a safety net
// How long to tolerate zero pipelines before concluding the repo has no CI
// configured for this MR/PR, rather than CI simply not having registered
// yet. Only applies before we've ever confirmed a pipeline exists (see
// `previousPipelineId === undefined` below) and only when hasCiConfig found
// no CI config file in the worktree — once either is untrue, an empty
// result can't mean "no CI".
const NO_PIPELINE_GRACE_MS = 60 * 1000;
const TERMINAL_STATUSES: Pipeline['status'][] = ['success', 'failed', 'canceled', 'skipped'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the worktree itself has a CI config file for `forge`. A repo that
 * has one will eventually run a pipeline even if the forge's API hasn't
 * registered it yet (slow runner pickup, branch/rules delay) — so the
 * no-pipeline grace window below must never fire in that case, only when
 * there's genuinely no CI config to run.
 *
 * Checks only the conventional path for each forge; a GitLab project whose
 * "CI/CD configuration file" setting points elsewhere (a custom path or a
 * separate repo) reads as unconfigured here and keeps the old grace-window
 * behavior — a known gap, not a false "no CI".
 */
export function hasCiConfig(worktreePath: string, forge: ForgeName): boolean {
  if (forge === 'gitlab') {
    return existsSync(join(worktreePath, '.gitlab-ci.yml'));
  }
  const workflowsDir = join(worktreePath, '.github', 'workflows');
  return existsSync(workflowsDir) && readdirSync(workflowsDir).some((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

export type PollOutcome = { kind: 'pipeline'; pipeline: Pipeline } | { kind: 'conflict' } | { kind: 'no-pipeline' };

/**
 * Waits for either a *new* terminal pipeline, a confirmed merge conflict, or
 * (only on the first pipeline of the run) confirmation that no CI is
 * configured at all — whichever comes first. `previousPipelineId` is the one
 * we already handled, and it stays "latest" on the forge until the pipeline
 * for our fix push is created — without this, the loop would re-fix stale
 * logs and burn attempts on a single real failure.
 *
 * The conflict check runs on every interval (not just once per outer loop
 * iteration): some repos never run CI on an unmergeable PR, so waiting for a
 * terminal pipeline that will never arrive would otherwise spin until the
 * 2-hour safety window times out instead of surfacing the conflict promptly.
 *
 * `noPipelineGraceMs` defaults to NO_PIPELINE_GRACE_MS and is only overridable
 * so tests don't have to wait out the real grace window. `ciConfigured`
 * (see hasCiConfig) disarms the grace window entirely: a repo with a real CI
 * config file must never be declared "no CI" just because its pipeline is
 * slow to register — it should keep polling the full window instead.
 */
/**
 * Undefined previousPipelineId means no pipeline has been confirmed yet for
 * this MR/PR; give the forge a short grace window to register one before
 * concluding there's no CI to watch. Only armed when ciConfigured is false —
 * a repo with a real CI config file can never reach this conclusion, no
 * matter how many polls come back empty.
 */
function computeInitialGracePolls(
  ciConfigured: boolean,
  previousPipelineId: number | undefined,
  noPipelineGraceMs: number,
  intervalMs: number,
): number | undefined {
  return !ciConfigured && previousPipelineId === undefined ? Math.max(1, Math.ceil(noPipelineGraceMs / intervalMs)) : undefined;
}

/** The latest pipeline, if it's both new (not previousPipelineId) and terminal — the condition pollForNextAction is waiting on. */
function checkTerminalPipeline(pipelines: Pipeline[], previousPipelineId: number | undefined): Pipeline | undefined {
  const latest = pipelines[0];
  return latest && latest.id !== previousPipelineId && TERMINAL_STATUSES.includes(latest.status) ? latest : undefined;
}

// fallow-ignore-next-line complexity
export async function pollForNextAction(
  forge: ForgeClient,
  mrIid: number,
  intervalMs: number,
  previousPipelineId?: number,
  noPipelineGraceMs: number = NO_PIPELINE_GRACE_MS,
  ciConfigured: boolean = false,
): Promise<PollOutcome> {
  const maxPolls = Math.max(1, Math.ceil(MAX_POLL_WINDOW_MS / intervalMs));
  let noPipelineGracePolls = computeInitialGracePolls(ciConfigured, previousPipelineId, noPipelineGraceMs, intervalMs);
  let emptyPolls = 0;
  for (let i = 0; i < maxPolls; i++) {
    if (await forge.hasMergeConflicts(mrIid)) {
      return { kind: 'conflict' };
    }

    const pipelines = await forge.getMrPipelines(mrIid);
    const terminal = checkTerminalPipeline(pipelines, previousPipelineId);
    if (terminal) {
      return { kind: 'pipeline', pipeline: terminal };
    }
    if (pipelines[0]) {
      noPipelineGracePolls = undefined; // CI is confirmed to exist; never re-arm the no-pipeline check
    } else if (noPipelineGracePolls !== undefined) {
      emptyPolls += 1;
      if (emptyPolls >= noPipelineGracePolls) {
        return { kind: 'no-pipeline' };
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`MR ${mrIid} did not reach a terminal pipeline state or a resolvable conflict within the polling window`);
}

function buildConflictPrompt(conflictedFiles: string[]): string {
  return (
    `This branch has merge conflicts with the target branch in the following file(s): ${conflictedFiles.join(', ')}. ` +
    'Resolve the conflict markers (<<<<<<<, =======, >>>>>>>) in each file by choosing the correct combined content ' +
    'that preserves the intent of both sides, then remove the markers. Do not run git commands — pipeline-worker ' +
    'stages and commits the resolution itself.'
  );
}

function writeAgentMcpConfig(): string {
  const path = join(tmpdir(), `pipeline-worker-mcp-${randomUUID()}.json`);
  const config = { mcpServers: { 'pipeline-worker-forge': { type: 'stdio', command: 'npx', args: ['pipeline-worker', 'serve'], env: {} } } };
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  return path;
}

function forgeLabel(forgeName: ForgeName): string {
  return forgeName === 'gitlab' ? 'GitLab' : 'GitHub';
}

function buildFixPrompt(pipeline: Pipeline, forgeName: ForgeName): string {
  const label = forgeLabel(forgeName);
  return (
    `The CI pipeline ${pipeline.webUrl} (id ${pipeline.id}) failed. Use whichever ${label} MCP server tooling is ` +
    `available in this environment (pipeline-worker's own forge MCP server, or an external ${label} MCP server if ` +
    'one is configured) to see which jobs failed and why, then fix the underlying issue in this worktree so the ' +
    'pipeline passes.'
  );
}

/**
 * Renders an escalation note as a headline plus a per-stage checklist —
 * the same ❌/⚠️ glyphs cli.ts prints for a failed/inconclusive stage (see
 * ui/steps.ts's runStep), so what lands in the MR/PR matches what the user
 * already watched scroll by in the terminal.
 */
function formatEscalationNote(headline: string, bullets: string[], footer: string): string {
  return `🚨 **${headline}**\n\n${bullets.map((b) => `- ${b}`).join('\n')}\n\n${footer}`;
}

async function escalate(forge: ForgeClient, mrIid: number, message: string, state: RunState, repoRoot: string): Promise<void> {
  // message may be a multi-line checklist (see formatEscalationNote); runStep's
  // detail line assumes single-line text (it doesn't collapse newlines the way
  // note() does), so flatten it there while posting the full body to the MR/PR.
  const detail = message.replace(/\s*\n\s*/g, ' ');
  await runStep('12.7', '🚨', 'Escalating to a human', detail, () => forge.createMrNote(mrIid, message));
  state.phase = 'escalated';
  recordEvent(repoRoot, state, detail, 'error');
}

/** Attempts `git merge origin/targetBranch`; true means it succeeded and auto-committed, false means conflicts are left in the working tree. */
async function attemptCleanMerge(worktreePath: string, targetBranch: string): Promise<boolean> {
  return runStep('12.2', '🔀', 'Merging target branch', `git merge origin/${targetBranch} --no-edit`, async () => {
    await execFileAsync('git', ['fetch', 'origin', targetBranch], { cwd: worktreePath });
    try {
      await execFileAsync('git', ['merge', `origin/${targetBranch}`, '--no-edit'], { cwd: worktreePath });
      return true; // merge succeeded and auto-committed; nothing left to resolve
    } catch {
      return false; // conflicts left in the working tree, merge in progress
    }
  });
}

/** Asks the agent to resolve the given conflicted files, returning whichever still have unresolved markers afterward. */
async function resolveConflictsWithAgent(agent: AgentAdapter, worktreePath: string, conflictedFiles: string[]): Promise<string[]> {
  note(conflictedFiles.join(', '));

  const mcpConfigPath = writeAgentMcpConfig();
  let agentResult: AgentInvokeResult;
  try {
    agentResult = await runStep(
      '12.3',
      '🔧',
      'Resolving conflicts',
      `asking the agent to resolve ${conflictedFiles.length} conflicted file(s)`,
      () => agent.invoke({ prompt: buildConflictPrompt(conflictedFiles), cwd: worktreePath, mcpConfigPath, permissionMode: 'acceptEdits' }),
    );
  } finally {
    unlinkSync(mcpConfigPath);
  }
  reportAgentInvocation(agentResult, worktreePath);

  return findUnresolvedConflictMarkers(worktreePath, conflictedFiles);
}

async function finalizeMergeResolution(worktreePath: string, targetBranch: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await commit(worktreePath, `merge: resolve conflicts with origin/${targetBranch}`);
}

/**
 * Merges origin/targetBranch into the worktree's branch to clear a confirmed
 * merge conflict, asking the agent to resolve any real conflict markers.
 * Shares state.attempt/config.maxFixAttempts with the CI-fix loop — both are
 * "automated intervention attempts before giving up and escalating to a
 * human" from the same budget. Returns false when it escalated instead of
 * resolving (caller should stop the run in that case).
 */
// fallow-ignore-next-line complexity
async function tryResolveConflicts(
  forge: ForgeClient,
  agent: AgentAdapter,
  config: PipelineWorkerConfig,
  worktreePath: string,
  branch: string,
  targetBranch: string,
  mrIid: number,
  state: RunState,
  repoRoot: string,
): Promise<boolean> {
  state.attempt += 1;
  recordEvent(repoRoot, state, `Merge conflicts detected; attempt ${state.attempt}/${config.maxFixAttempts} — merging origin/${targetBranch} into ${branch}`);

  step('⚠️', 'Merge conflicts detected', `attempt ${state.attempt}/${config.maxFixAttempts} — merging origin/${targetBranch} into ${branch}`);
  if (state.attempt > config.maxFixAttempts) {
    await escalate(
      forge,
      mrIid,
      formatEscalationNote(
        `Automated fix attempts exhausted (${state.attempt - 1} attempt(s))`,
        [`❌ Merge conflicts with \`origin/${targetBranch}\` could not be resolved automatically`],
        'This MR/PR needs a human to resolve them.',
      ),
      state,
      repoRoot,
    );
    return false;
  }

  const cleanMerge = await attemptCleanMerge(worktreePath, targetBranch);

  if (!cleanMerge) {
    const conflictedFiles = await listConflictedFiles(worktreePath);
    if (conflictedFiles.length === 0) {
      throw new Error(`git merge origin/${targetBranch} failed for a reason other than conflicts — check the worktree for details`);
    }

    const stillConflicted = await resolveConflictsWithAgent(agent, worktreePath, conflictedFiles);
    if (stillConflicted.length > 0) {
      await escalate(
        forge,
        mrIid,
        formatEscalationNote(
          'Merge conflict resolution failed',
          [`❌ Agent left ${stillConflicted.length} file(s) still conflicted: ${stillConflicted.join(', ')}`],
          'Escalating to a human.',
        ),
        state,
        repoRoot,
      );
      return false;
    }

    await finalizeMergeResolution(worktreePath, targetBranch);
  }

  await runStep('12.4', '⬆', 'Pushing the merge', `push ${branch} to origin`, () => push(worktreePath, 'origin', branch));
  return true;
}

/** No CI ran at all (repo has no workflow configured for this MR/PR) — there's nothing to poll for, so stop instead of spinning until the 2-hour safety window would otherwise time out. */
async function handleNoPipelineOutcome(state: RunState, repoRoot: string): Promise<void> {
  step('ℹ️', 'No CI pipeline found', `no pipeline was detected for the MR/PR within ${NO_PIPELINE_GRACE_MS / 1000}s — nothing to watch`);
  state.phase = 'done';
  recordEvent(repoRoot, state, 'No CI pipeline found for this MR/PR — nothing to watch');
}

/** What watchPipeline's outer polling loop should do next, since only it can act on `continue`/`return`. */
type PipelineOutcomeResult = { action: 'stop' } | { action: 'continue'; previousPipelineId: number };

/** Attempts one CI fix: diagnose/fix via the agent, then commit and push. Shares state.attempt/config.maxFixAttempts with the conflict-resolution loop. */
async function runCiFixAttempt(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  branch: string,
  mrIid: number,
  pipeline: Pipeline,
  state: RunState,
  repoRoot: string,
): Promise<PipelineOutcomeResult> {
  state.attempt += 1;
  recordEvent(repoRoot, state, `Pipeline failed; attempt ${state.attempt}/${config.maxFixAttempts} — ${pipeline.webUrl}`);

  step('💥', 'Pipeline failed', `attempt ${state.attempt}/${config.maxFixAttempts} — ${pipeline.webUrl}`);
  if (state.attempt > config.maxFixAttempts) {
    await escalate(
      forge,
      mrIid,
      formatEscalationNote(
        `Automated fix attempts exhausted (${state.attempt - 1} attempt(s))`,
        [`❌ CI pipeline: still failing — ${pipeline.webUrl}`],
        'Needs a human to take over.',
      ),
      state,
      repoRoot,
    );
    return { action: 'stop' };
  }

  const mcpConfigPath = writeAgentMcpConfig();
  let agentResult: AgentInvokeResult;
  try {
    agentResult = await runStep(
      '12.5',
      '🔧',
      'Fixing CI failure',
      `asking the agent to diagnose and fix ${pipeline.webUrl} via whatever ${forgeLabel(config.forge)} MCP tooling is available`,
      () => agent.invoke({ prompt: buildFixPrompt(pipeline, config.forge), cwd: worktreePath, mcpConfigPath, permissionMode: 'acceptEdits' }),
    );
  } finally {
    unlinkSync(mcpConfigPath);
  }
  reportAgentInvocation(agentResult, worktreePath);

  if (!(await hasChanges(worktreePath))) {
    // Re-pushing an identical tree would never produce a new pipeline; stop here.
    await escalate(
      forge,
      mrIid,
      formatEscalationNote(
        'Fix attempt produced no changes',
        [`❌ CI pipeline: still failing — ${pipeline.webUrl}`, `⚠️ Agent fix attempt ${state.attempt} made no changes to push`],
        'Escalating to a human.',
      ),
      state,
      repoRoot,
    );
    return { action: 'stop' };
  }

  await runStep('12.6', '⬆', 'Pushing the fix', `commit and push attempt ${state.attempt} to ${branch}`, async () => {
    await stageAll(worktreePath);
    await commit(worktreePath, `fix: address CI failure (attempt ${state.attempt})`);
    await push(worktreePath, 'origin', branch);
  });
  return { action: 'continue', previousPipelineId: pipeline.id };
}

/** Dispatches on a terminal pipeline's status: done (success), escalate (canceled/skipped), or attempt a CI fix (failed). */
async function handlePipelineTerminal(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  branch: string,
  mrIid: number,
  pipeline: Pipeline,
  state: RunState,
  repoRoot: string,
): Promise<PipelineOutcomeResult> {
  note(`pipeline ${pipeline.id}: ${pipeline.status} — ${pipeline.webUrl}`);
  state.pipelineId = pipeline.id;
  recordEvent(repoRoot, state, `Pipeline ${pipeline.id}: ${pipeline.status} — ${pipeline.webUrl}`);

  if (pipeline.status === 'success') {
    state.phase = 'done';
    recordEvent(repoRoot, state, 'Pipeline succeeded');
    return { action: 'stop' };
  }

  if (pipeline.status !== 'failed') {
    // canceled/skipped: there are no failing jobs to fix — don't spend agent tokens.
    await escalate(
      forge,
      mrIid,
      formatEscalationNote(
        'Pipeline ended without a clear pass/fail',
        [`⚠️ CI pipeline: \`${pipeline.status}\` — ${pipeline.webUrl}`],
        'Nothing to auto-fix — needs a human decision.',
      ),
      state,
      repoRoot,
    );
    return { action: 'stop' };
  }

  return runCiFixAttempt(forge, config, agent, worktreePath, branch, mrIid, pipeline, state, repoRoot);
}

// fallow-ignore-next-line complexity
export async function watchPipeline(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  branch: string,
  targetBranch: string,
  mrIid: number,
  state: RunState,
  repoRoot: string,
): Promise<void> {
  const intervalMs = config.pollIntervalSeconds * 1000;
  const ciConfigured = hasCiConfig(worktreePath, config.forge);
  state.phase = 'watch';
  recordEvent(repoRoot, state, 'Started watching pipeline');

  let previousPipelineId: number | undefined;
  for (;;) {
    const outcome = await runStep(
      '12.1',
      '👀',
      'Watching pipeline',
      `poll CI every ${config.pollIntervalSeconds}s until it finishes`,
      () => pollForNextAction(forge, mrIid, intervalMs, previousPipelineId, NO_PIPELINE_GRACE_MS, ciConfigured),
    );

    if (outcome.kind === 'conflict') {
      const resolved = await tryResolveConflicts(forge, agent, config, worktreePath, branch, targetBranch, mrIid, state, repoRoot);
      if (!resolved) return; // already escalated inside tryResolveConflicts
      continue;
    }

    if (outcome.kind === 'no-pipeline') {
      await handleNoPipelineOutcome(state, repoRoot);
      return;
    }

    const result = await handlePipelineTerminal(forge, config, agent, worktreePath, branch, mrIid, outcome.pipeline, state, repoRoot);
    if (result.action === 'stop') return;
    previousPipelineId = result.previousPipelineId;
  }
}
