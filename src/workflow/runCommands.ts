/**
 * The `resume` and `review` commands as callable functions, so both the CLI
 * (src/cli.ts) and the TUI's sessions browser drive exactly the same code
 * path. They were inline command actions until the TUI needed them; the
 * behaviour is unchanged except that a precondition failure now throws instead
 * of calling process.exit — the CLI turns that back into an exit code, while
 * the TUI shows it as an error and stays running.
 */

import { watchPipeline } from './watchPipeline.js';
import { adoptBranch, resolveResumeMode } from './adoptBranch.js';
import { continueRun, resumeHint } from './orchestrate.js';
import { maybeSyncTargetBranch } from './syncTargetBranch.js';
import { maybeReviewMergeRequest } from './reviewMr.js';
import { resumeSkeleton, adoptSkeleton, reviewSkeleton } from './runPlan.js';
import { loadConfig } from '../config/loader.js';
import { createForge } from '../forge/index.js';
import { selectAgent } from '../agent/index.js';
import { loadRunState, recordEvent } from '../state/runState.js';
import { isWorktreeOnBranch, checkoutExistingBranch, removeWorktree, worktreeExists } from '../git/worktree.js';
import { remoteBranchExists } from '../git/remote.js';
import { beginRun, endRun, note, runStep, seedRunTokens, setPlainOutput } from '../ui/steps.js';
import { setCompletionSound } from '../ui/notify.js';
import { makeIdempotentCleanup, registerExitSignals } from '../process/signalCleanup.js';
import type { ForgeClient } from '../forge/types.js';
import type { AgentAdapter } from '../agent/types.js';
import type { PipelineWorkerConfig, ResumableRunState, RunPhase, RunState } from '../types.js';

/**
 * Adoption works off the branch as origin has it (see
 * git/worktree.ts's checkoutExistingBranch), so a branch that was never
 * pushed — a run that died before its push, leaving only a state file — has
 * nothing to adopt. Caught here to say so plainly, rather than surfacing a
 * raw `git fetch` failure.
 */
async function requirePushedBranch(repoRoot: string, branch: string): Promise<void> {
  if (await remoteBranchExists(repoRoot, branch)) return;
  throw new Error(
    `branch ${branch} does not exist on origin — there is nothing to resume or adopt. ` +
      'Re-run `pipeline-worker run` from your changes instead.',
  );
}

/**
 * A failed run keeps its worktree (see orchestrate.ts), so this normally
 * reattaches to the very worktree the crashed run was using. It is recreated
 * from the branch's current state on origin only when that worktree is gone
 * or has since moved to another branch.
 */
async function resolveResumeWorktree(repoRoot: string, state: ResumableRunState): Promise<string> {
  const worktreePath = (await isWorktreeOnBranch(state.worktreePath, state.branch))
    ? state.worktreePath
    : await checkoutExistingBranch(repoRoot, state.branch);
  if (worktreePath !== state.worktreePath) {
    state.worktreePath = worktreePath;
    recordEvent(repoRoot, state, `Recreated worktree at ${worktreePath}`);
  }
  return worktreePath;
}

async function runResumeWatch(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  state: ResumableRunState,
  repoRoot: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await watchPipeline(forge, config, agent, worktreePath, state.branch, state.targetBranch, state.mrIid, state, repoRoot);
    // Same 'merge' tail as a fresh run (see orchestrate.ts's finalizeRun):
    // when auto-merge landed the MR/PR, pull the merged result back into the
    // local target branch so it doesn't sit stale after the run ends.
    if (state.phase === 'done') {
      await maybeSyncTargetBranch(forge, config, repoRoot, state.targetBranch, state.mrIid);
      // The only outcome that removes the worktree: everything finished.
      await cleanup();
      endRun('done', `MR/PR #${state.mrIid} finished green`);
    } else if (state.phase === 'escalated') {
      note(`worktree kept at ${worktreePath} — ${resumeHint(state)}`);
      endRun('escalated', 'see the MR/PR comment for what was tried and why');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.failedStage = 'ci-watch';
    recordEvent(repoRoot, state, `Resume failed: ${message}`, 'error');
    // Deliberately no cleanup: the worktree is what the next resume re-enters.
    note(`worktree kept at ${worktreePath} — ${resumeHint(state)}`);
    endRun('failed', message);
    throw error;
  }
}

/**
 * A run that failed before its MR/PR existed is picked up from the stage it
 * died in (orchestrate.ts's continueRun) rather than adopted from origin —
 * but only while its worktree is still on disk, since that worktree holds the
 * applied diff, the rebase, and any fix made by hand in it. Without it there
 * is nothing to re-enter, and adoption (which works off origin) is the only
 * recovery left. Exported for unit testing.
 */
export async function findContinuableRun(repoRoot: string, branch: string): Promise<RunState | undefined> {
  const stored = loadRunState(repoRoot, branch);
  if (!stored || stored.mrIid !== undefined) return undefined;
  return (await worktreeExists(stored.worktreePath)) ? stored : undefined;
}

/** Resumes a crashed run, or adopts a pushed branch that has no run state, and watches its CI through to a verdict. Returns the phase it settled in. */
export async function resumeRun(repoRoot: string, opts: { branch: string; target?: string }): Promise<RunPhase> {
  const continuable = await findContinuableRun(repoRoot, opts.branch);
  if (continuable) return continueRun(repoRoot, continuable, { target: opts.target });

  const config = loadConfig(repoRoot);
  setCompletionSound(config.completionSound);
  setPlainOutput(config.plainOutput);
  const forge = createForge(config);
  const agent = selectAgent(config);

  const mode = resolveResumeMode(loadRunState(repoRoot, opts.branch), opts.target);
  let state: ResumableRunState;
  let worktreePath: string;
  if (mode.kind === 'resume') {
    beginRun(resumeSkeleton(mode.state.targetBranch), { title: opts.branch });
    if (mode.state.totalTokens !== undefined) seedRunTokens(mode.state.totalTokens);
    worktreePath = await runStep('resume', "reattach: reuse the crashed run's worktree, or recreate it from origin", () =>
      resolveResumeWorktree(repoRoot, mode.state),
    );
    state = mode.state;
  } else {
    await requirePushedBranch(repoRoot, opts.branch);
    beginRun(adoptSkeleton(opts.branch), { title: opts.branch });
    state = await adoptBranch(repoRoot, config, forge, agent, opts.branch, mode.target, mode.reason);
    worktreePath = state.worktreePath;
    // Adoption is the one resume path that just (re)opened an MR/PR, so
    // it is the one that has something new to review; a resumed run's
    // MR/PR was already reviewed when its original run opened it.
    await maybeReviewMergeRequest(forge, config, agent, worktreePath, state.targetBranch, state.mrIid);
  }

  const { cleanup } = makeIdempotentCleanup(() => removeWorktree(repoRoot, worktreePath));
  registerExitSignals((exitCode) => {
    endRun('interrupted', `resume again with: pipeline-worker resume --branch ${opts.branch}`);
    void cleanup().then(() => process.exit(exitCode));
  });

  await runResumeWatch(forge, config, agent, worktreePath, state, repoRoot, cleanup);
  return state.phase;
}

/** Reviews an open MR/PR's diff and posts line-anchored comments. Returns how many comments were posted. */
export async function reviewBranch(repoRoot: string, opts: { branch: string }): Promise<number> {
  const config = loadConfig(repoRoot);
  setCompletionSound(config.completionSound);
  setPlainOutput(config.plainOutput);
  const forge = createForge(config);
  const agent = selectAgent(config);

  const mr = await forge.findExistingMr(opts.branch);
  if (!mr) {
    throw new Error(`no open MR/PR found for branch ${opts.branch} — open one first (pipeline-worker resume --branch ${opts.branch}).`);
  }

  beginRun(reviewSkeleton(opts.branch), { title: opts.branch });
  const worktreePath = await runStep('adopt', `checkout ${opts.branch} into a disposable worktree`, () =>
    checkoutExistingBranch(repoRoot, opts.branch),
  );
  try {
    // Asking for a review explicitly *is* the opt-in, so config.review is
    // overridden here — the `review` setting only gates the automatic stage
    // inside `run`/`resume`.
    const posted = await maybeReviewMergeRequest(forge, { ...config, review: true }, agent, worktreePath, mr.targetBranch, mr.iid);
    endRun('done', posted > 0 ? `posted ${posted} comment(s) on ${mr.webUrl}` : `nothing worth commenting on — ${mr.webUrl}`);
    return posted;
  } finally {
    await removeWorktree(repoRoot, worktreePath);
  }
}
