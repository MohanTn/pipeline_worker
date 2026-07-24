/** Top-level control flow wiring the user's workflow steps together — see workflow/runPlan.ts for the full step skeleton. */

import { basename } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { createForge } from '../forge/index.js';
import { selectAgent } from '../agent/index.js';
import { captureDiff, resetRepo } from '../git/diff.js';
import { buildBranchName } from '../git/branchName.js';
import { createWorktree, syncWithOrigin, applyDiffToWorktree, removeWorktree, renameBranch, generateTempBranchName } from '../git/worktree.js';
import { currentBranch, commit, stageAll, findUnresolvedConflictMarkers, forcePushWithLease } from '../git/commit.js';
import { detectDefaultBranch, remoteBranchExists } from '../git/remote.js';
import { squashCommitsSinceMergeBase } from '../git/squash.js';
import { captureIntent } from './captureIntent.js';
import { runChecks } from './runChecks.js';
import { updateChangelog } from './updateChangelog.js';
import { openMergeRequest, appendToMergeRequest } from './openMergeRequest.js';
import { maybeReviewMergeRequest } from './reviewMr.js';
import { watchPipeline } from './watchPipeline.js';
import { maybeSyncTargetBranch } from './syncTargetBranch.js';
import { recordEvent, recordAgentTokens } from '../state/runState.js';
import { acquireLock } from '../state/lock.js';
import { makeIdempotentCleanup, registerExitSignals } from '../process/signalCleanup.js';
import { beginRun, endRun, runStep, skipStep, addDynamicStep, setRunHeader, note, noteRisk, reportAgentInvocation } from '../ui/steps.js';
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

/** Phases from 'mr' onward have an open MR/PR that `resume` continues pushing fixes to. */
const RESUMABLE_PHASES: RunPhase[] = ['mr', 'watch'];

/**
 * True once the run has an open MR/PR — from that point, `pipeline-worker
 * resume` needs the worktree to still exist to keep pushing CI-fix/conflict
 * resolution commits, so an interrupt must leave it in place instead of
 * deleting it. Before that point (still capturing/applying/checking the
 * diff), there is no MR to resume against, so the worktree is safe — and
 * meant — to remove on interrupt. Exported for unit testing.
 */
export function shouldPreserveWorktreeOnInterrupt(phase: RunPhase): boolean {
  return RESUMABLE_PHASES.includes(phase);
}

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
    () => agent.invoke({ prompt: buildApplyConflictPrompt(conflictedFiles), cwd: worktreePath, permissionMode: 'acceptEdits' }),
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
  const { diffText, changedFiles, untrackedFiles, modifiedCount, deletedCount } = await runStep(
    'capture',
    'reading uncommitted edits and untracked files from your repo',
    () => captureDiff(repoRoot),
  );
  if (diffText.trim().length === 0 && untrackedFiles.length === 0) {
    return null;
  }
  note(`${untrackedFiles.length} new file(s), ${modifiedCount} modified, ${deletedCount} deleted, ${diffText.split('\n').length} line(s) of diff`);
  return { diffText, changedFiles, untrackedFiles, modifiedCount, deletedCount };
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
export async function runAndReportChecks(config: PipelineWorkerConfig, worktreePath: string, state: RunState, repoRoot: string): Promise<CheckResult[] | null> {
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
    recordEvent(repoRoot, state, `${failedCheck.name} check failed, aborted before opening a merge request`, 'error');
    endRun('failed', `${failedCheck.name} failed — aborted before opening a merge request`);
    process.exitCode = 1;
    return null;
  }
  state.phase = 'checks';
  recordEvent(repoRoot, state, `Checks passed (${checks.map((c) => c.name).join(', ')})`);
  return checks;
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

/** Stage 9 + opening the MR/PR: commit everything staged so far, then open the merge request and record it on state. */
async function commitAndOpenMr(
  forge: ForgeClient,
  worktreePath: string,
  state: RunState,
  targetBranch: string,
  intent: CapturedIntent,
  config: PipelineWorkerConfig,
  checks: CheckResult[],
  repoRoot: string,
): Promise<MergeRequest> {
  await runStep(
    'commit',
    `commit message: "${intent.commitMessage}"`,
    // applyDiffToWorktree (and, if enabled, the changelog step above) left
    // everything staged; without this commit the push would carry no
    // changes and the MR would be empty.
    () => commit(worktreePath, intent.commitMessage),
  );

  const mr = await openMergeRequest(forge, worktreePath, state.branch, targetBranch, intent, config.agent, checks, config.autoMergeOnGreen, config.mergeMethod);
  state.mrIid = mr.iid;
  state.phase = 'mr';
  recordEvent(repoRoot, state, `Opened MR/PR ${mr.webUrl}`);
  return mr;
}

/**
 * Follow-up counterpart of commitAndOpenMr: commit this run's fix and add it
 * to the MR/PR that already exists for the branch the caller is on (the
 * "reviewer left a comment, I fixed it, run pipeline-worker again" case).
 * Nothing new is opened — the commit lands on the same branch and the
 * file-wise breakdown is appended to the same description.
 */
async function commitOntoExistingMr(
  forge: ForgeClient,
  worktreePath: string,
  state: RunState,
  existingMr: MergeRequest,
  intent: CapturedIntent,
  config: PipelineWorkerConfig,
  checks: CheckResult[],
  repoRoot: string,
): Promise<MergeRequest> {
  await runStep('commit', `commit message: "${intent.commitMessage}"`, () => commit(worktreePath, intent.commitMessage));

  await appendToMergeRequest(forge, worktreePath, existingMr, intent, config.agent, checks);

  state.mrIid = existingMr.iid;
  state.phase = 'mr';
  recordEvent(repoRoot, state, `Added a follow-up commit to existing MR/PR ${existingMr.webUrl}`);
  return existingMr;
}

/** What stages 5-11 produced, whichever of the two paths ran: the state to carry forward, the captured intent, and the MR/PR the run now watches. */
interface MrStageResult {
  state: RunState;
  intent: CapturedIntent;
  mr: MergeRequest;
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

/** Stages 5-11, follow-up path: capture intent, commit, and add both to the MR/PR already open for this branch. */
async function runFollowUpMrStage(
  agent: AgentAdapter,
  config: PipelineWorkerConfig,
  forge: ForgeClient,
  worktreePath: string,
  state: RunState,
  repoRoot: string,
  changedFiles: string[],
  untrackedFiles: string[],
  checks: CheckResult[],
  followUpMr: MergeRequest,
): Promise<MrStageResult> {
  const { intent, intentTokens } = await captureRunIntent(agent, config, worktreePath, changedFiles, untrackedFiles);

  skipStep('branch', `this commit belongs on ${followUpMr.sourceBranch}, the branch of the open MR/PR — no new branch`);
  setRunHeader({ title: followUpMr.sourceBranch });

  const nextState: RunState = { ...state, branch: followUpMr.sourceBranch, phase: 'intent' };
  recordEvent(repoRoot, nextState, `Captured intent for a follow-up commit on ${followUpMr.sourceBranch}`, 'info', intentTokens);

  await maybeUpdateChangelog(config, worktreePath, intent);
  const mr = await commitOntoExistingMr(forge, worktreePath, nextState, followUpMr, intent, config, checks, repoRoot);
  return { state: nextState, intent, mr };
}

/** Stages 5-11, normal path: capture intent, move onto a fresh feature branch, commit, and open the MR/PR. */
async function runFreshMrStage(
  agent: AgentAdapter,
  config: PipelineWorkerConfig,
  options: RunWorkflowOptions,
  forge: ForgeClient,
  worktreePath: string,
  state: RunState,
  repoRoot: string,
  changedFiles: string[],
  untrackedFiles: string[],
  checks: CheckResult[],
  targetBranch: string,
): Promise<MrStageResult> {
  const { intent, intentTokens, actualBranchName } = await captureIntentAndBranch(agent, config, options, worktreePath, changedFiles, untrackedFiles);

  const nextState: RunState = { ...state, branch: actualBranchName, phase: 'intent' };
  recordEvent(repoRoot, nextState, `Captured intent; renamed to feature branch ${actualBranchName}`, 'info', intentTokens);

  await maybeUpdateChangelog(config, worktreePath, intent);
  const mr = await commitAndOpenMr(forge, worktreePath, nextState, targetBranch, intent, config, checks, repoRoot);
  return { state: nextState, intent, mr };
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

/** After watchPipeline settles: report the final outcome, run stage 13's cleanup if it hasn't already run early, then stage 14's local target-branch sync. */
// fallow-ignore-next-line complexity
async function finalizeRun(
  finalPhase: RunPhase,
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  mr: MergeRequest,
  state: RunState,
  repoRoot: string,
  untrackedFiles: string[],
  worktreePath: string,
  targetBranch: string,
  intent: CapturedIntent,
  isFollowUp: boolean,
): Promise<void> {
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

    const detail = state.pipelineId !== undefined ? `MR ${mr.webUrl} passed CI` : `MR ${mr.webUrl} opened — no CI pipeline found, nothing to watch`;
    endRun('done', detail);
  } else if (finalPhase === 'escalated') {
    endRun('escalated', `see ${mr.webUrl} for what was tried and why`);
    process.exitCode = 1;
  }
}

// fallow-ignore-next-line complexity
export async function runWorkflow(repoRoot: string, options: RunWorkflowOptions = {}): Promise<void> {
  const config = loadConfig(repoRoot);
  setCompletionSound(config.completionSound);
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
    // A follow-up run rebases onto the MR/PR's own branch, so a commit pushed
    // there since (a reviewer's fixup, another run) is never clobbered.
    const syncBranch = followUpMr ? followUpMr.sourceBranch : targetBranch;
    beginRun(freshRunSkeleton(targetBranch, config.agent), { title: basename(repoRoot) });
    if (followUpMr) {
      note(`${followUpMr.sourceBranch} already has an open MR/PR (${followUpMr.webUrl}) — adding this change to it instead of opening a new one`);
    }

    const diff = await captureRunDiff(repoRoot);
    if (!diff) {
      endRun('done', 'no changes to process — your working tree is clean');
      return;
    }
    const { diffText, changedFiles, untrackedFiles } = diff;

    const tempBranch = generateTempBranchName();
    const worktreePath = await runStep(
      'worktree',
      `create worktree with name ${tempBranch}`,
      () => createWorktree(repoRoot, tempBranch),
    );
    // The uuid tail of the temp branch, shortened, doubles as the header's
    // worktree identifier (the mock's 'worktree a91f').
    setRunHeader({ worktreeShortId: tempBranch.slice(-4) });

    let state: RunState = { branch: tempBranch, targetBranch, worktreePath, ciFixAttempt: 0, conflictAttempt: 0, phase: 'diff' };
    recordEvent(repoRoot, state, `Created worktree at ${worktreePath} (temp branch ${tempBranch})`);

    const { cleanup, markDone } = makeIdempotentCleanup(() => removeWorktree(repoRoot, worktreePath));
    registerExitSignals((exitCode) => {
      // Settle the run display first so the terminal is left readable (and,
      // under the live TTY renderer, the cursor is restored).
      endRun('interrupted', shouldPreserveWorktreeOnInterrupt(state.phase) ? `resume with: pipeline-worker resume --branch ${state.branch}` : undefined);
      // process.exit() below terminates immediately without unwinding the
      // suspended runWorkflow() call stack, so the outer `finally { releaseLock() }`
      // never runs — release it explicitly here first in both branches.
      if (shouldPreserveWorktreeOnInterrupt(state.phase)) {
        // MR is already open — leave the worktree so `pipeline-worker resume`
        // can keep pushing CI-fix/conflict-resolution commits to it instead
        // of finding a dead path.
        markDone();
        releaseLock();
        process.exit(exitCode);
        return;
      }
      void cleanup().then(() => {
        releaseLock();
        process.exit(exitCode);
      });
    });

    try {
      await applyCapturedDiff(agent, repoRoot, state, worktreePath, syncBranch, diffText, untrackedFiles);

      const checks = await runAndReportChecks(config, worktreePath, state, repoRoot);
      if (!checks) return;

      const staged = followUpMr
        ? await runFollowUpMrStage(agent, config, forge, worktreePath, state, repoRoot, changedFiles, untrackedFiles, checks, followUpMr)
        : await runFreshMrStage(agent, config, options, forge, worktreePath, state, repoRoot, changedFiles, untrackedFiles, checks, targetBranch);
      state = staged.state;
      const { intent, mr } = staged;

      // Line-anchored review of what this run is about to ask CI (and a
      // human) to accept. A follow-up run is scoped to the files it just
      // touched: the rest of the branch has already been through review.
      const posted = await maybeReviewMergeRequest(
        forge,
        config,
        agent,
        worktreePath,
        targetBranch,
        mr.iid,
        followUpMr ? changedFiles : undefined,
      );
      if (posted > 0) recordEvent(repoRoot, state, `Posted ${posted} review comment(s) on MR/PR #${mr.iid}`);

      // This runs before stage 12 (watching the pipeline) even though it's
      // numbered 13 — it's the same stage 13 that would otherwise run after
      // stage 12 finishes, just moved earlier by config.cleanupEarly.
      await maybeCleanupEarly(config, repoRoot, untrackedFiles, state.branch, releaseLock);

      await watchPipeline(forge, config, agent, worktreePath, state.branch, targetBranch, mr.iid, state, repoRoot);

      // watchPipeline mutates state.phase in place; go through a function
      // boundary so TS uses the declared RunPhase return type instead of the
      // 'mr' literal it narrowed state.phase to just before the call.
      const finalPhase = readPhase(state);
      await finalizeRun(finalPhase, forge, config, mr, state, repoRoot, untrackedFiles, worktreePath, targetBranch, intent, followUpMr !== undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordEvent(repoRoot, state, `Run failed: ${message}`, 'error');
      endRun('failed', message);
      throw error;
    } finally {
      await cleanup();
    }
  } finally {
    releaseLock();
  }
}
