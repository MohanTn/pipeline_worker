/** Top-level control flow wiring the user's workflow steps together — see workflow/runPlan.ts for the full step skeleton. */

import { basename } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { createForge } from '../forge/index.js';
import { selectAgent } from '../agent/index.js';
import { captureDiff, resetRepo } from '../git/diff.js';
import { buildBranchName } from '../git/branchName.js';
import { createWorktree, syncWithOrigin, applyDiffToWorktree, removeWorktree, renameBranch, resetWorktree, generateTempBranchName } from '../git/worktree.js';
import { currentBranch, commit, stageAll, findUnresolvedConflictMarkers, forcePushWithLease, hasChanges, checkoutBranch } from '../git/commit.js';
import { detectDefaultBranch, remoteBranchExists } from '../git/remote.js';
import { squashCommitsSinceMergeBase } from '../git/squash.js';
import { captureIntent } from './captureIntent.js';
import { runChecks } from './runChecks.js';
import { updateChangelog } from './updateChangelog.js';
import { openMergeRequest, appendToMergeRequest } from './openMergeRequest.js';
import { maybeReviewMergeRequest } from './reviewMr.js';
import { watchPipeline } from './watchPipeline.js';
import { maybeSyncTargetBranch } from './syncTargetBranch.js';
import { recordEvent, recordAgentTokens, deleteRunState } from '../state/runState.js';
import { acquireLock } from '../state/lock.js';
import { makeIdempotentCleanup, registerExitSignals } from '../process/signalCleanup.js';
import { RunCancelledError } from '../process/cancelScope.js';
import { beginRun, endRun, runStep, skipStep, addDynamicStep, setRunHeader, seedRunTokens, note, noteRisk, reportAgentInvocation, setPlainOutput } from '../ui/steps.js';
import { setCompletionSound } from '../ui/notify.js';
import { freshRunSkeleton } from './runPlan.js';
import { printWelcome } from '../ui/welcome.js';
import type { AgentAdapter } from '../agent/types.js';
import type { CapturedDiff } from '../git/diff.js';
import type { ForgeClient } from '../forge/types.js';
import type { CapturedIntent, CheckResult, MergeRequest, PipelineWorkerConfig, RunPhase, RunState } from '../types.js';

/** Function-boundary read so TS reports the declared RunPhase union, not a narrowed literal. */
function readPhase(state: RunState): RunPhase {
  return state.phase;
}

/**
 * The stages in the order they run. A run records the phase each stage
 * completed, so a resumed run skips everything at or before its stored phase
 * and re-enters at the stage that failed. 'done'/'escalated' sit at the end
 * because both mean every earlier stage finished.
 */
const PHASE_ORDER: RunPhase[] = ['diff', 'apply', 'checks', 'intent', 'commit', 'mr', 'watch', 'escalated', 'done'];

/** True when `phase` says `target`'s stage already finished. Exported for unit testing. */
export function phaseReached(phase: RunPhase, target: RunPhase): boolean {
  return PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf(target);
}

/**
 * A failed or interrupted run keeps its worktree — that is what makes the
 * stage it died in re-enterable — so every exit that isn't a clean finish
 * tells the user the one command that picks it back up.
 */
export function resumeHint(state: RunState): string {
  return `resume with: pipeline-worker resume --branch ${state.branch}`;
}

/** Same two-capability gate as watchPipeline.ts's conflict turn: read and write files, no shell. */
const CONFLICT_TOOLS = ['Read', 'Write', 'Edit'];

const CONFLICT_SYSTEM =
  'You resolve git merge conflicts by editing the conflicted files. You may only read and write files — you run ' +
  'no commands, and you make no change beyond resolving the conflicts you are given.';

function buildApplyConflictPrompt(conflictedFiles: string[]): string {
  return (
    `Applying your diff produced merge conflicts (the target branch moved since the diff was captured) in: ${conflictedFiles.join(', ')}. ` +
    'Resolve the conflict markers (<<<<<<<, =======, >>>>>>>) in each file by choosing the correct combined content ' +
    'that preserves the intent of both sides, then remove the markers.'
  );
}

/**
 * A best-effort, single attempt: there's no MR yet at this point in the
 * workflow, so unlike watchPipeline.ts's CI-fix/merge-conflict loops there's
 * nothing to leave an escalation comment on if the agent can't resolve it —
 * fail the run clearly instead so the user can intervene manually.
 */
async function resolveApplyConflicts(agent: AgentAdapter, repoRoot: string, state: RunState, worktreePath: string, conflictedFiles: string[]): Promise<void> {
  addDynamicStep('apply', 'apply/conflicts', 'conflicts');
  const agentResult = await runStep(
    'apply/conflicts',
    `asking the agent to resolve ${conflictedFiles.length} conflicted file(s)`,
    () =>
      agent.invoke({
        prompt: buildApplyConflictPrompt(conflictedFiles),
        systemPrompt: CONFLICT_SYSTEM,
        cwd: worktreePath,
        permissionMode: 'acceptEdits',
        allowedTools: CONFLICT_TOOLS,
      }),
  );
  reportAgentInvocation(agentResult, worktreePath);
  recordAgentTokens(repoRoot, state, 'resolve diff-apply conflicts', agentResult.usage);

  const stillConflicted = findUnresolvedConflictMarkers(worktreePath, conflictedFiles);
  if (stillConflicted.length > 0) {
    throw new Error(
      `pipeline-worker: could not automatically resolve conflicts applying your diff — ${stillConflicted.join(', ')} ` +
        'still have conflict markers. Resolve them manually and retry.',
    );
  }
  await stageAll(worktreePath);
}

export interface RunWorkflowOptions {
  /** Ticket/issue id to interpolate into config.branchPattern's {ticket} placeholder, if it has one. */
  ticket?: string;
  /** `--target`: base branch for the MR/PR, overriding origin's auto-detected default branch. */
  target?: string;
}

/**
 * The branch this run's MR/PR targets: `--target` if given, else origin's
 * default branch (`main`/`master` — see git/remote.ts), else, only when
 * origin can't answer at all, the branch the caller is standing on.
 *
 * That last tier is what every run used to do unconditionally, which meant
 * running from a feature branch silently opened a stacked MR/PR into that
 * feature branch instead of into trunk.
 */
export async function resolveTargetBranch(repoRoot: string, override?: string): Promise<string> {
  if (override) {
    let exists: boolean;
    try {
      exists = await remoteBranchExists(repoRoot, override);
    } catch {
      exists = true; // origin unreachable — let the sync step be the one to complain
    }
    if (!exists) {
      throw new Error(`pipeline-worker: --target ${override} does not exist on origin — push it first, or pass a branch that does.`);
    }
    return override;
  }

  try {
    return await detectDefaultBranch(repoRoot);
  } catch {
    // No origin, or a repo whose trunk is named something else entirely.
  }

  const branch = await currentBranch(repoRoot);
  if (branch === 'HEAD') {
    throw new Error("pipeline-worker: detached HEAD and no default branch on origin to target — pass --target <branch> explicitly.");
  }
  return branch;
}

/** Step 'capture': read the uncommitted diff, or null (already reported) when there's nothing to process. */
async function captureRunDiff(repoRoot: string): Promise<CapturedDiff | null> {
  const { diffText, changedFiles, untrackedFiles, stagedNewCount, modifiedCount, deletedCount } = await runStep(
    'capture',
    'reading uncommitted edits and untracked files from your repo',
    () => captureDiff(repoRoot),
  );
  if (diffText.trim().length === 0 && untrackedFiles.length === 0) {
    return null;
  }
  note(`${untrackedFiles.length + stagedNewCount} new file(s), ${modifiedCount} modified, ${deletedCount} deleted, ${diffText.split('\n').length} line(s) of diff`);
  return { diffText, changedFiles, untrackedFiles, stagedNewCount, modifiedCount, deletedCount };
}

/** Stages 3-4: sync the worktree with origin, replay the captured diff, and resolve any resulting conflicts. */
async function applyCapturedDiff(
  agent: AgentAdapter,
  repoRoot: string,
  state: RunState,
  worktreePath: string,
  targetBranch: string,
  diffText: string,
  untrackedFiles: string[],
): Promise<void> {
  await runStep(
    'sync',
    `pull --rebase origin ${targetBranch}, so the diff lands on the latest base`,
    () => syncWithOrigin(worktreePath, targetBranch),
  );

  const applyResult = await runStep(
    'apply',
    'replay your diff and untracked files into the new worktree',
    () => applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot),
  );
  if (applyResult.conflicted) {
    note(`conflict in: ${applyResult.conflictedFiles.join(', ')}`);
    await resolveApplyConflicts(agent, repoRoot, state, worktreePath, applyResult.conflictedFiles);
  }
}

/** Stage 5: ask the agent to infer the change's type, slug, commit message, summary, and per-file breakdown. */
async function captureRunIntent(
  agent: AgentAdapter,
  config: PipelineWorkerConfig,
  worktreePath: string,
  changedFiles: string[],
  untrackedFiles: string[],
): Promise<{ intent: CapturedIntent; intentTokens?: number }> {
  const { intent, usage } = await runStep(
    'intent',
    `ask ${config.agent} to infer a change type, branch slug, commit message, and summary`,
    () => captureIntent(agent, [...changedFiles, ...untrackedFiles], worktreePath, config.intentModel),
  );
  note(`${config.agent} says: ${intent.summary}`);
  noteRisk(intent.risk, intent.riskReason);
  return { intent, intentTokens: usage?.totalTokens };
}

/** Stages 5-6: capture intent, then rename the worktree to the resulting feature branch. */
async function captureIntentAndBranch(
  agent: AgentAdapter,
  config: PipelineWorkerConfig,
  options: RunWorkflowOptions,
  worktreePath: string,
  changedFiles: string[],
  untrackedFiles: string[],
): Promise<{ intent: CapturedIntent; intentTokens?: number; actualBranchName: string }> {
  const { intent, intentTokens } = await captureRunIntent(agent, config, worktreePath, changedFiles, untrackedFiles);

  const branchName = buildBranchName(config.branchPattern, { type: intent.changeType, ticket: options.ticket, name: intent.branchSlug });
  const actualBranchName = await runStep(
    'branch',
    `switch to feature branch ${branchName}`,
    () => renameBranch(worktreePath, branchName),
  );
  if (actualBranchName !== branchName) {
    note(`"${branchName}" already exists locally — using "${actualBranchName}" instead`);
  }
  setRunHeader({ title: actualBranchName });
  return { intent, intentTokens, actualBranchName };
}

/**
 * Stage 7: run build/lint/test, reporting and recording the outcome. Returns
 * null (already logged/recorded, exitCode set) when a check failed. Exported
 * for reuse by adoptBranch.ts's "no PR/MR yet" path, which runs this exact
 * stage before opening a new PR/MR for a branch pipeline-worker never created.
 */
export async function runAndReportChecks(
  config: PipelineWorkerConfig,
  worktreePath: string,
  state: RunState,
  repoRoot: string,
  failureHint?: string,
): Promise<CheckResult[] | null> {
  const checks = await runStep(
    'checks',
    'build, lint, and test — whichever your repo has configured',
    () => runChecks(config, worktreePath),
  );
  for (const check of checks) note(`${check.name}: ${check.ok ? 'passed' : 'failed'} (${(check.durationMs / 1000).toFixed(1)}s)`);
  const failedCheck = checks.find((c) => !c.ok);
  if (failedCheck) {
    console.error(
      `pipeline-worker: ${failedCheck.name} failed, aborting before opening a merge request.\n${failedCheck.stderr}`,
    );
    state.failedStage = 'checks';
    recordEvent(repoRoot, state, `${failedCheck.name} check failed, aborted before opening a merge request`, 'error');
    // Before endRun: once the run display settles, nothing more is painted.
    if (failureHint) note(failureHint);
    endRun('failed', `${failedCheck.name} failed — aborted before opening a merge request`);
    process.exitCode = 1;
    return null;
  }
  state.phase = 'checks';
  state.checks = summarizeChecks(checks);
  state.failedStage = undefined;
  recordEvent(repoRoot, state, `Checks passed (${checks.map((c) => c.name).join(', ')})`);
  return checks;
}

/**
 * What the state file keeps of a check run: only the name/verdict/duration
 * ever reach an MR/PR description, and a full test log would bloat every
 * `sessions` read of the file.
 */
function summarizeChecks(checks: CheckResult[]): CheckResult[] {
  return checks.map(({ name, ok, durationMs }) => ({ name, ok, durationMs, stdout: '', stderr: '' }));
}

/**
 * Stage 8 (optional): add a changelog bullet for this change, or announce the
 * skip when disabled. Exported for reuse by adoptBranch.ts.
 */
export async function maybeUpdateChangelog(config: PipelineWorkerConfig, worktreePath: string, intent: CapturedIntent): Promise<void> {
  if (config.updateChangelog) {
    await runStep(
      'changelog',
      "add a bullet under CHANGELOG.md's [Unreleased] section",
      async () => {
        updateChangelog(worktreePath, intent);
        await stageAll(worktreePath);
      },
    );
  } else {
    skipStep('changelog', 'config.updateChangelog is disabled');
  }
}

/**
 * The three facts both MR/PR paths write onto state. The web URL is stored
 * alongside the iid because only the forge's own response is right for a
 * self-hosted host — everything downstream (sessions, the TUI's copy key)
 * reads it back rather than guessing.
 */
export function recordMrOnState(state: RunState, mr: MergeRequest): void {
  state.mrIid = mr.iid;
  state.mrUrl = mr.webUrl;
  state.phase = 'mr';
  state.failedStage = undefined;
}

/**
 * Everything the stages below need that doesn't change between them. Built
 * once by `runWorkflow` for a fresh run and by `continueRun` for a resumed
 * one — the stages themselves cannot tell the two apart, which is what keeps
 * "resume from where it failed" from being a second implementation of the
 * workflow.
 */
interface PipelineContext {
  config: PipelineWorkerConfig;
  agent: AgentAdapter;
  forge: ForgeClient;
  repoRoot: string;
  worktreePath: string;
  options: RunWorkflowOptions;
  targetBranch: string;
  /** Branch the worktree rebases onto: the MR/PR's own branch for a follow-up, else the target branch. */
  syncBranch: string;
  followUpMr?: MergeRequest;
  /** The diff a fresh run captured up front. Absent on a resumed run, which re-reads it only if it never got applied. */
  diff?: CapturedDiff;
}

/** Which stage is currently executing, so the failure handler can record where the run died without every stage having to report it. */
interface StageCursor {
  stage: string;
}

/**
 * A resumed run whose original died before (or during) `apply` re-reads the
 * caller's working tree: diff text runs to megabytes for a binary-heavy
 * change, far too much to keep in the state file, and it is still sitting in
 * repoRoot untouched precisely because a failed run no longer resets it.
 */
async function recaptureForResume(ctx: PipelineContext): Promise<CapturedDiff> {
  const diff = await runStep(
    'capture',
    'reading your uncommitted edits again — the run being resumed never finished applying them',
    () => captureDiff(ctx.repoRoot),
  );
  if (diff.diffText.trim().length === 0 && diff.untrackedFiles.length === 0) {
    throw new Error(
      'pipeline-worker: your working tree is clean, so there is no diff left to apply — the run being resumed never got past `apply`. Start a fresh `pipeline-worker run` instead.',
    );
  }
  await runStep('worktree', 'discarding the partial apply left behind in the worktree', () => resetWorktree(ctx.worktreePath));
  return diff;
}

/** Stages 3-4, or a skip announcement when the preserved worktree already holds the applied diff. */
async function ensureAppliedDiff(ctx: PipelineContext, state: RunState, cursor: StageCursor): Promise<void> {
  if (phaseReached(state.phase, 'apply')) {
    skipStep('capture', 'the diff is already in the preserved worktree');
    skipStep('worktree', `reusing ${state.worktreePath}`);
    skipStep('sync', 'the run being resumed already rebased onto the target branch');
    skipStep('apply', 'the run being resumed already replayed the diff');
    return;
  }
  cursor.stage = 'apply';
  const diff = ctx.diff ?? (await recaptureForResume(ctx));
  await applyCapturedDiff(ctx.agent, ctx.repoRoot, state, ctx.worktreePath, ctx.syncBranch, diff.diffText, diff.untrackedFiles);
  state.phase = 'apply';
  state.changedFiles = diff.changedFiles;
  state.untrackedFiles = diff.untrackedFiles;
  state.failedStage = undefined;
  recordEvent(ctx.repoRoot, state, `Applied the captured diff into ${ctx.worktreePath}`);
}

/** Stage 7, or the stored verdicts when the run being resumed already passed them. */
async function ensureChecks(ctx: PipelineContext, state: RunState, cursor: StageCursor): Promise<CheckResult[] | null> {
  if (phaseReached(state.phase, 'checks')) {
    skipStep('checks', 'already passed in the run being resumed');
    return state.checks ?? [];
  }
  cursor.stage = 'checks';
  return runAndReportChecks(
    ctx.config,
    ctx.worktreePath,
    state,
    ctx.repoRoot,
    `worktree kept at ${state.worktreePath} — fix it there, then ${resumeHint(state)}`,
  );
}

/** Stages 5-6, or the intent the run being resumed already paid the agent for. */
async function ensureIntent(ctx: PipelineContext, state: RunState, cursor: StageCursor): Promise<CapturedIntent> {
  if (phaseReached(state.phase, 'intent') && state.intent) {
    skipStep('intent', 'reusing the intent captured by the run being resumed');
    skipStep('branch', `already on ${state.branch}`);
    setRunHeader({ title: state.branch });
    return state.intent;
  }
  cursor.stage = 'intent';
  const changedFiles = state.changedFiles ?? [];
  const untrackedFiles = state.untrackedFiles ?? [];
  const previousBranch = state.branch;

  let intent: CapturedIntent;
  let intentTokens: number | undefined;
  if (ctx.followUpMr) {
    ({ intent, intentTokens } = await captureRunIntent(ctx.agent, ctx.config, ctx.worktreePath, changedFiles, untrackedFiles));
    skipStep('branch', `this commit belongs on ${ctx.followUpMr.sourceBranch}, the branch of the open MR/PR — no new branch`);
    setRunHeader({ title: ctx.followUpMr.sourceBranch });
    state.branch = ctx.followUpMr.sourceBranch;
  } else {
    const captured = await captureIntentAndBranch(ctx.agent, ctx.config, ctx.options, ctx.worktreePath, changedFiles, untrackedFiles);
    intent = captured.intent;
    intentTokens = captured.intentTokens;
    state.branch = captured.actualBranchName;
  }

  state.intent = intent;
  state.phase = 'intent';
  state.failedStage = undefined;
  const headline = ctx.followUpMr ? `Captured intent for a follow-up commit on ${state.branch}` : `Captured intent; renamed to feature branch ${state.branch}`;
  recordEvent(ctx.repoRoot, state, headline, 'info', intentTokens);
  // State is keyed by branch, so the rename above wrote a second file; drop
  // the temp-branch one rather than leave `sessions`/`resume` a stale entry
  // pointing at a worktree that has since moved on.
  if (state.branch !== previousBranch) deleteRunState(ctx.repoRoot, previousBranch);
  return intent;
}

/** Stages 8-9, or a skip announcement when the run being resumed already committed. */
async function ensureCommit(ctx: PipelineContext, state: RunState, intent: CapturedIntent, cursor: StageCursor): Promise<void> {
  if (phaseReached(state.phase, 'commit')) {
    skipStep('changelog', 'already written by the run being resumed');
    skipStep('commit', 'the run being resumed already committed this change');
    return;
  }
  cursor.stage = 'commit';
  await maybeUpdateChangelog(ctx.config, ctx.worktreePath, intent);
  await runStep('commit', `commit message: "${intent.commitMessage}"`, async () => {
    // applyDiffToWorktree (and, if enabled, the changelog step) already left
    // everything staged; staging again costs nothing and picks up whatever a
    // resumed run's user fixed by hand in the worktree. Without the commit
    // the push would carry no changes and the MR would be empty.
    await stageAll(ctx.worktreePath);
    await commit(ctx.worktreePath, intent.commitMessage);
  });
  state.phase = 'commit';
  state.failedStage = undefined;
  recordEvent(ctx.repoRoot, state, `Committed "${intent.commitMessage}"`);
}

/**
 * Stages 10-11: push and either open a new MR/PR or append this commit to the
 * one already open for the branch (the "reviewer left a comment, I fixed it,
 * ran pipeline-worker again" case — nothing new is opened, the file-wise
 * breakdown is appended to the same description).
 */
/**
 * `priorPipelineId` is the id of whatever pipeline the forge already reports
 * as latest for this MR/PR *before* this stage's push (undefined for a brand
 * new MR/PR, which has no pipeline history to be confused with) — the caller
 * threads it into watchPipeline so the CI-watch loop's first poll never mistakes
 * that pre-existing pipeline for the one this run's push triggers.
 */
async function ensureMergeRequest(
  ctx: PipelineContext,
  state: RunState,
  intent: CapturedIntent,
  checks: CheckResult[],
  cursor: StageCursor,
): Promise<{ mr: MergeRequest; priorPipelineId: number | undefined }> {
  cursor.stage = 'mr';
  if (ctx.followUpMr) {
    const priorPipelineId = await appendToMergeRequest(ctx.forge, ctx.worktreePath, ctx.followUpMr, intent, ctx.config.agent, checks);
    recordMrOnState(state, ctx.followUpMr);
    recordEvent(ctx.repoRoot, state, `Added a follow-up commit to existing MR/PR ${ctx.followUpMr.webUrl}`);
    return { mr: ctx.followUpMr, priorPipelineId };
  }
  const mr = await openMergeRequest(
    ctx.forge,
    ctx.worktreePath,
    state.branch,
    ctx.targetBranch,
    intent,
    ctx.config.agent,
    checks,
    ctx.config.autoMergeOnGreen,
    ctx.config.mergeMethod,
  );
  recordMrOnState(state, mr);
  recordEvent(ctx.repoRoot, state, `Opened MR/PR ${mr.webUrl}`);
  return { mr, priorPipelineId: undefined };
}

/**
 * The MR/PR already open for the branch the caller is standing on, if any —
 * its existence is what makes this run a follow-up (a reviewer asked for a
 * change, you made it, you ran pipeline-worker again) rather than a new
 * feature branch. A detached HEAD has no branch name to match on, so it can
 * never be one. Exported for unit testing.
 */
export async function findFollowUpMr(forge: ForgeClient, repoRoot: string): Promise<MergeRequest | undefined> {
  const branch = await currentBranch(repoRoot);
  if (branch === 'HEAD') return undefined;
  return forge.findExistingMr(branch);
}

/**
 * Stage 13, run early: once the MR/PR is open, repoRoot's copy is redundant
 * even though CI hasn't run yet, so free it (and the run lock) for a new
 * `pipeline-worker run` immediately, rather than making the caller wait out
 * this run's CI-watch/fix loop. releaseLock is safe to call again from the
 * outer `finally` once this run itself finishes.
 */
async function maybeCleanupEarly(config: PipelineWorkerConfig, repoRoot: string, untrackedFiles: string[], branch: string, releaseLock: () => void): Promise<void> {
  if (config.cleanupOnSuccess && config.cleanupEarly) {
    await runStep(
      'cleanup',
      `reset to HEAD — your changes are now safely pushed to ${branch} (MR open)`,
      () => resetRepo(repoRoot, untrackedFiles),
    );
    releaseLock();
  }
}

/**
 * Opt-in (config.squashOnMerge): collapses every commit this run made on the
 * branch into one, titled from the captured intent, then force-pushes.
 * Best-effort — never fails an otherwise-successful run. In particular, if
 * config.autoMergeOnGreen is also on, the forge may have already merged (and
 * possibly deleted) the branch via its own webhook before this runs; that
 * shows up here as a push failure and is logged as a no-op, not an error.
 */
async function maybeSquashCommits(config: PipelineWorkerConfig, worktreePath: string, branch: string, targetBranch: string, intent: CapturedIntent): Promise<void> {
  addDynamicStep('ci-watch', 'ci-watch/squash', 'squash');
  if (!config.squashOnMerge) {
    skipStep('ci-watch/squash', 'config.squashOnMerge is disabled');
    return;
  }
  try {
    await runStep('ci-watch/squash', `collapsing into one commit: "${intent.commitMessage}"`, async () => {
      await squashCommitsSinceMergeBase(worktreePath, targetBranch, intent.commitMessage);
      await forcePushWithLease(worktreePath, 'origin', branch);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    noteRisk('low', `could not squash run commits (${message}) — likely already merged; leaving history as-is`);
  }
}

/**
 * Stage 15 (opt-out via config.switchToFeatureBranch): leave repoRoot standing
 * on the branch this run built, instead of on the target branch it started
 * from. That is what makes the next round of edits a follow-up: `pipeline-worker
 * run` from this branch commits onto the same MR/PR (see findFollowUpMr)
 * rather than opening a second one, so no manual `git checkout` — or, worse, a
 * hunt for the deleted worktree's path — is needed between rounds.
 *
 * The run's worktree holds the branch until it is removed, and git refuses one
 * branch in two worktrees, so `cleanup` (idempotent — the outer finally calls
 * it again harmlessly) runs first. Best-effort throughout: a repo that still
 * has uncommitted changes is left alone rather than dragging them onto the
 * branch, and a failed checkout is a note, not a failed run.
 *
 * Exported for unit testing.
 */
export async function maybeSwitchToFeatureBranch(
  config: PipelineWorkerConfig,
  repoRoot: string,
  branch: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  if (!config.switchToFeatureBranch) {
    skipStep('switch', 'config.switchToFeatureBranch is disabled');
    return;
  }
  try {
    if (await hasChanges(repoRoot)) {
      skipStep('switch', `${repoRoot} still has uncommitted changes — not carrying them onto ${branch}`);
      return;
    }
    await runStep('switch', `check out ${branch}, so your next change becomes a follow-up commit on this MR/PR`, async () => {
      await cleanup();
      await checkoutBranch(repoRoot, branch);
    });
    note(`you are on ${branch} now — edit, then run pipeline-worker again to add a follow-up commit to the same MR/PR`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    noteRisk('low', `could not check out ${branch} in your repo (${message}) — switch by hand with: git checkout ${branch}`);
  }
}

/** After watchPipeline settles: report the final outcome, run stage 13's cleanup if it hasn't already run early, then stage 14's local target-branch sync. */
// fallow-ignore-next-line complexity
async function finalizeRun(
  finalPhase: RunPhase,
  ctx: PipelineContext,
  mr: MergeRequest,
  state: RunState,
  intent: CapturedIntent,
  cleanup: () => Promise<void>,
): Promise<void> {
  const { config, forge, repoRoot, worktreePath, targetBranch } = ctx;
  const untrackedFiles = state.untrackedFiles ?? [];
  const isFollowUp = ctx.followUpMr !== undefined;
  if (finalPhase === 'done') {
    if (isFollowUp) {
      // Squashing here would rewrite an MR/PR a human is already reviewing,
      // collapsing the commits their comments are anchored to.
      addDynamicStep('ci-watch', 'ci-watch/squash', 'squash');
      skipStep('ci-watch/squash', 'this run added a commit to an MR/PR already under review — not rewriting its history');
    } else {
      await maybeSquashCommits(config, worktreePath, state.branch, targetBranch, intent);
    }

    if (config.cleanupOnSuccess) {
      // Only run the cleanup step here when it hasn't already run early,
      // above — no skip announcement needed in that case, since it did run,
      // just sooner than usual, not never.
      if (!config.cleanupEarly) {
        await runStep(
          'cleanup',
          `reset to HEAD — your changes are now safely on ${state.branch}`,
          () => resetRepo(repoRoot, untrackedFiles),
        );
      }
    } else {
      skipStep('cleanup', 'config.cleanupOnSuccess is disabled — leaving your changes on the local repo for you to inspect');
    }

    if (isFollowUp && config.cleanupOnSuccess) {
      note(`your local ${state.branch} does not have this commit yet — the run made it in its own worktree; \`git pull\` to catch up`);
    }

    // After cleanup on purpose: with cleanupOnSuccess on, the working tree is
    // clean by now, so the fast-forward can't collide with leftover local edits.
    await maybeSyncTargetBranch(forge, config, repoRoot, targetBranch, mr.iid);

    // Last, so the branch swap can't disturb any stage that reads repoRoot's
    // working tree (cleanup's reset, the target-branch fast-forward).
    await maybeSwitchToFeatureBranch(config, repoRoot, state.branch, cleanup);

    const detail = state.pipelineId !== undefined ? `MR ${mr.webUrl} passed CI` : `MR ${mr.webUrl} opened — no CI pipeline found, nothing to watch`;
    endRun('done', detail);
  } else if (finalPhase === 'escalated') {
    note(`worktree kept at ${worktreePath} — ${resumeHint(state)}`);
    endRun('escalated', `see ${mr.webUrl} for what was tried and why`);
    process.exitCode = 1;
  }
}

/**
 * Settles a run stopped from the TUI's dashboard. Applies exactly the policy
 * the SIGINT handler below applies — the worktree is kept whatever phase the
 * run reached, because every phase is now a stage `resume` can re-enter —
 * minus the process.exit, since the TUI must survive and paint the settled
 * dashboard. `markDone` satisfies the caller's idempotent cleanup without
 * running it, so nothing removes the worktree on the way out. Exported for
 * unit testing.
 */
export function settleCancelledRun(repoRoot: string, state: RunState, markDone: () => void): void {
  state.failedStage ??= state.phase;
  recordEvent(repoRoot, state, 'Run cancelled from the TUI', 'error');
  endRun('interrupted', resumeHint(state));
  markDone();
}

/**
 * Runs every stage from wherever `state.phase` says the pipeline is, through
 * the CI watch and the finalize tail. Each stage records the phase it
 * completed before the next one starts, which is what lets a failed run be
 * picked up at exactly the stage that failed rather than from the top.
 */
// fallow-ignore-next-line complexity
async function runPipeline(
  ctx: PipelineContext,
  state: RunState,
  cursor: StageCursor,
  cleanup: () => Promise<void>,
  releaseLock: () => void,
): Promise<void> {
  await ensureAppliedDiff(ctx, state, cursor);

  const checks = await ensureChecks(ctx, state, cursor);
  if (!checks) return; // check failure is already narrated, and the worktree is kept for a resume

  const intent = await ensureIntent(ctx, state, cursor);
  await ensureCommit(ctx, state, intent, cursor);
  const { mr, priorPipelineId } = await ensureMergeRequest(ctx, state, intent, checks, cursor);

  // Line-anchored review of what this run is about to ask CI (and a human) to
  // accept. A follow-up run is scoped to the files it just touched: the rest
  // of the branch has already been through review.
  cursor.stage = 'review';
  // Only `posted` matters here: the review's clean/not verdict exists for
  // `review --branch`'s approval stage, which a run never reaches.
  const { posted } = await maybeReviewMergeRequest(
    ctx.forge,
    ctx.config,
    ctx.agent,
    ctx.worktreePath,
    ctx.targetBranch,
    mr.iid,
    ctx.followUpMr ? state.changedFiles : undefined,
  );
  if (posted > 0) recordEvent(ctx.repoRoot, state, `Posted ${posted} review comment(s) on MR/PR #${mr.iid}`);

  // This runs before stage 12 (watching the pipeline) even though it's
  // numbered 13 — it's the same stage 13 that would otherwise run after
  // stage 12 finishes, just moved earlier by config.cleanupEarly.
  cursor.stage = 'cleanup';
  await maybeCleanupEarly(ctx.config, ctx.repoRoot, state.untrackedFiles ?? [], state.branch, releaseLock);

  cursor.stage = 'ci-watch';
  await watchPipeline(ctx.forge, ctx.config, ctx.agent, ctx.worktreePath, state.branch, ctx.targetBranch, mr.iid, state, ctx.repoRoot, priorPipelineId);

  // watchPipeline mutates state.phase in place; go through a function
  // boundary so TS uses the declared RunPhase return type instead of the
  // 'mr' literal it narrowed state.phase to just before the call.
  const finalPhase = readPhase(state);
  cursor.stage = 'finalize';
  await finalizeRun(finalPhase, ctx, mr, state, intent, cleanup);

  // The one exit that removes the worktree: the run finished. Anything else
  // (a failure, an escalation, an interrupt) leaves it on disk so `resume`
  // can re-enter the stage that stopped it.
  if (finalPhase === 'done') await cleanup();
}

/**
 * Wraps runPipeline in the worktree/lock lifecycle both entry points share:
 * signal handling, the cancel path, and the failure path that records which
 * stage died and tells the user how to pick it up.
 */
async function drivePipeline(ctx: PipelineContext, state: RunState, releaseLock: () => void): Promise<void> {
  const { cleanup, markDone } = makeIdempotentCleanup(() => removeWorktree(ctx.repoRoot, ctx.worktreePath));
  const cursor: StageCursor = { stage: state.phase };

  registerExitSignals((exitCode) => {
    // Settle the run display first so the terminal is left readable (and,
    // under the live TTY renderer, the cursor is restored).
    endRun('interrupted', resumeHint(state));
    // The worktree always survives an interrupt now: `resume` re-enters at
    // whatever stage the run had reached. process.exit() below terminates
    // immediately without unwinding the suspended call stack, so the outer
    // `finally { releaseLock() }` never runs — release it explicitly here.
    markDone();
    releaseLock();
    process.exit(exitCode);
  });

  try {
    await runPipeline(ctx, state, cursor, cleanup, releaseLock);
  } catch (error) {
    // A cancel is a deliberate stop, not a failure: settle the display and
    // return normally so the TUI stays up (the CLI's SIGINT path exits the
    // process instead).
    if (error instanceof RunCancelledError) {
      settleCancelledRun(ctx.repoRoot, state, markDone);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    state.failedStage = cursor.stage;
    recordEvent(ctx.repoRoot, state, `Run failed in the ${cursor.stage} stage: ${message}`, 'error');
    note(`worktree kept at ${ctx.worktreePath} — ${resumeHint(state)}`);
    endRun('failed', message);
    throw error;
  }
}

// fallow-ignore-next-line complexity
export async function runWorkflow(repoRoot: string, options: RunWorkflowOptions = {}): Promise<void> {
  const config = loadConfig(repoRoot);
  setCompletionSound(config.completionSound);
  setPlainOutput(config.plainOutput);
  if (config.forge === 'gitlab' && !options.ticket) {
    throw new Error('forge is gitlab, which requires a ticket id — pass one with --ticket <id>.');
  }
  // Held for the whole run so a second `pipeline-worker run` in this repo
  // fails fast instead of racing this one's captureDiff/resetRepo against
  // the same working tree.
  const releaseLock = acquireLock(repoRoot);
  try {
    const forge = createForge(config);
    const agent = selectAgent(config);
    await printWelcome(config, repoRoot);

    // Both reads happen before the first step renders, since the skeleton
    // needs the target branch for its sync/merge details. A follow-up run
    // inherits the open MR/PR's own target instead of resolving one: the
    // MR/PR already decided what it merges into.
    const followUpMr = await findFollowUpMr(forge, repoRoot);
    const targetBranch = followUpMr ? followUpMr.targetBranch : await resolveTargetBranch(repoRoot, options.target);
    beginRun(freshRunSkeleton(targetBranch, config.agent), { title: basename(repoRoot) });
    if (followUpMr) {
      note(`${followUpMr.sourceBranch} already has an open MR/PR (${followUpMr.webUrl}) — adding this change to it instead of opening a new one`);
    }

    const diff = await captureRunDiff(repoRoot);
    if (!diff) {
      endRun('done', 'no changes to process — your working tree is clean');
      return;
    }

    const tempBranch = generateTempBranchName();
    const worktreePath = await runStep(
      'worktree',
      `create worktree with name ${tempBranch}`,
      () => createWorktree(repoRoot, tempBranch),
    );
    // The uuid tail of the temp branch, shortened, doubles as the header's
    // worktree identifier (the mock's 'worktree a91f').
    setRunHeader({ worktreeShortId: tempBranch.slice(-4) });

    const state: RunState = {
      branch: tempBranch,
      targetBranch,
      worktreePath,
      ciFixAttempt: 0,
      conflictAttempt: 0,
      phase: 'diff',
      changedFiles: diff.changedFiles,
      untrackedFiles: diff.untrackedFiles,
      followUpMrIid: followUpMr?.iid,
    };
    recordEvent(repoRoot, state, `Created worktree at ${worktreePath} (temp branch ${tempBranch})`);

    await drivePipeline(
      {
        config,
        agent,
        forge,
        repoRoot,
        worktreePath,
        options,
        targetBranch,
        // A follow-up run rebases onto the MR/PR's own branch, so a commit
        // pushed there since (a reviewer's fixup, another run) is never clobbered.
        syncBranch: followUpMr ? followUpMr.sourceBranch : targetBranch,
        followUpMr,
        diff,
      },
      state,
      releaseLock,
    );
  } finally {
    releaseLock();
  }
}

/**
 * `pipeline-worker resume` for a run that failed before its MR/PR existed:
 * re-enters the same pipeline with the stored state, so every stage the run
 * already completed is skipped and the one it died in runs again. The
 * worktree is the failed run's own — kept precisely for this — so the applied
 * diff, the rebase onto the target branch, and any fix made by hand inside it
 * are all still there.
 */
export async function continueRun(repoRoot: string, state: RunState, options: RunWorkflowOptions = {}): Promise<RunPhase> {
  const config = loadConfig(repoRoot);
  setCompletionSound(config.completionSound);
  setPlainOutput(config.plainOutput);
  const releaseLock = acquireLock(repoRoot);
  try {
    const forge = createForge(config);
    const agent = selectAgent(config);
    // Re-read the MR/PR a follow-up run was adding to: only its iid is
    // persisted, and the stages need the whole record (source branch, url).
    const followUpMr = state.followUpMrIid !== undefined ? await forge.findExistingMr(state.branch) : undefined;

    beginRun(freshRunSkeleton(state.targetBranch, config.agent), { title: state.branch, worktreeShortId: state.worktreePath.slice(-4) });
    if (state.totalTokens !== undefined) seedRunTokens(state.totalTokens);
    note(`picking up the ${state.failedStage ?? state.phase} stage of the run in ${state.worktreePath}`);

    await drivePipeline(
      {
        config,
        agent,
        forge,
        repoRoot,
        worktreePath: state.worktreePath,
        options,
        targetBranch: state.targetBranch,
        syncBranch: followUpMr ? followUpMr.sourceBranch : state.targetBranch,
        followUpMr,
        diff: undefined,
      },
      state,
      releaseLock,
    );
    return state.phase;
  } finally {
    releaseLock();
  }
}
