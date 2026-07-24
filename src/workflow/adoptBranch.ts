/**
 * `pipeline-worker resume --branch <name>`'s branch-adoption path: handles a
 * branch pipeline-worker has no recorded state for at all (typically: a user
 * committed and pushed it by hand, never running `pipeline-worker run` on
 * it). Checks out the branch, checks the forge for an already-open PR/MR, and:
 *
 * - No PR/MR yet: runs it like a fresh `pipeline-worker run` from this point
 *   on — checks, capture intent, open the MR/PR — against `targetOverride` or
 *   the auto-detected remote default branch.
 * - PR/MR already exists: re-captures intent from the branch's actual diff
 *   and overwrites the PR/MR description with it, using the MR/PR's own
 *   target branch (no guessing needed).
 *
 * Either way, returns a ResumableRunState so cli.ts's `resume` command can
 * hand off to the same watchPipeline() tail it already runs for a crash-
 * recovered run.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkoutExistingBranch, removeWorktree } from '../git/worktree.js';
import { commit, hasChanges, mergeBase, stageAll } from '../git/commit.js';
import { changedFilesSinceRef } from '../git/diff.js';
import { detectDefaultBranch } from '../git/remote.js';
import { recordEvent, recordAgentTokens } from '../state/runState.js';
import { captureIntent } from './captureIntent.js';
import { runAndReportChecks, maybeUpdateChangelog } from './orchestrate.js';
import { openMergeRequest, buildDescription } from './openMergeRequest.js';
import { runStep, skipStep, note, announce } from '../ui/steps.js';
import type { ForgeClient } from '../forge/types.js';
import type { AgentAdapter } from '../agent/types.js';
import type { PipelineWorkerConfig, ResumableRunState, RunState } from '../types.js';

const execFileAsync = promisify(execFile);

async function fetchBranch(worktreePath: string, branch: string): Promise<void> {
  await execFileAsync('git', ['fetch', 'origin', branch], { cwd: worktreePath });
}

/** The list of files this branch changed relative to `targetBranch`, and the fixed commit that comparison is pinned to (see git/commit.ts's mergeBase). */
async function diffSinceTarget(worktreePath: string, targetBranch: string): Promise<{ files: string[]; baseRef: string }> {
  await fetchBranch(worktreePath, targetBranch);
  const baseRef = await mergeBase(worktreePath, `origin/${targetBranch}`);
  const files = await changedFilesSinceRef(worktreePath, baseRef);
  return { files, baseRef };
}

/** An MR/PR already exists for this branch: refresh its description from a fresh intent capture, using the MR's own target branch. */
async function adoptWithExistingMr(
  agent: AgentAdapter,
  config: PipelineWorkerConfig,
  forge: ForgeClient,
  worktreePath: string,
  state: RunState,
  repoRoot: string,
  existingMr: { iid: number; targetBranch: string; webUrl: string },
  targetOverride: string | undefined,
): Promise<ResumableRunState> {
  if (targetOverride) {
    note(`--target ${targetOverride} ignored — MR/PR ${existingMr.webUrl} already targets ${existingMr.targetBranch}`);
  }
  state.targetBranch = existingMr.targetBranch;

  const { files, baseRef } = await runStep(
    'inspect',
    `comparing against origin/${existingMr.targetBranch}`,
    () => diffSinceTarget(worktreePath, existingMr.targetBranch),
  );

  // These skeleton steps only run on the no-MR-yet path (adoptWithoutMr):
  // an already-open MR/PR means the branch is pushed and CI re-verifies it.
  skipStep('checks', 'MR/PR already open — its CI pipeline verifies the branch');
  skipStep('changelog', 'not updated when refreshing an existing MR/PR');
  skipStep('push', 'branch is already pushed — that is how its MR/PR exists');

  const { intent, usage } = await runStep(
    'intent',
    `ask ${config.agent} to infer a summary, risk, and file-by-file breakdown`,
    () => captureIntent(agent, files, worktreePath, config.intentModel, baseRef),
  );
  note(`${config.agent} says: ${intent.summary}`);

  await runStep('mr', `overwriting the description of MR/PR ${existingMr.webUrl}`, () =>
    forge.updateMrDescription(existingMr.iid, buildDescription(intent, config.agent, []), undefined),
  );

  state.mrIid = existingMr.iid;
  state.phase = 'mr';
  recordEvent(repoRoot, state, `Overwrote description for existing MR/PR ${existingMr.webUrl}`, 'info', usage?.totalTokens);
  return state as ResumableRunState;
}

/** No MR/PR exists yet for this branch: run it like a fresh `pipeline-worker run` from checks onward. */
async function adoptWithoutMr(
  agent: AgentAdapter,
  config: PipelineWorkerConfig,
  forge: ForgeClient,
  worktreePath: string,
  state: RunState,
  repoRoot: string,
  branch: string,
  targetOverride: string | undefined,
): Promise<ResumableRunState> {
  const targetBranch = targetOverride ?? (await detectDefaultBranch(repoRoot));
  state.targetBranch = targetBranch;
  recordEvent(repoRoot, state, `No existing MR/PR found; targeting ${targetBranch}`);

  const { files, baseRef } = await runStep(
    'inspect',
    `comparing against origin/${targetBranch}`,
    () => diffSinceTarget(worktreePath, targetBranch),
  );

  const checks = await runAndReportChecks(config, worktreePath, state, repoRoot);
  if (!checks) {
    throw new Error(`pipeline-worker: local checks failed for branch ${branch} — aborting before opening a merge request.`);
  }

  const { intent, usage } = await runStep(
    'intent',
    `ask ${config.agent} to infer a summary, risk, and file-by-file breakdown`,
    () => captureIntent(agent, files, worktreePath, config.intentModel, baseRef),
  );
  note(`${config.agent} says: ${intent.summary}`);
  recordAgentTokens(repoRoot, state, 'capture intent for adopted branch', usage);

  await maybeUpdateChangelog(config, worktreePath, intent);
  if (await hasChanges(worktreePath)) {
    await stageAll(worktreePath);
    await commit(worktreePath, 'chore: update changelog');
  }

  const mr = await openMergeRequest(forge, worktreePath, branch, targetBranch, intent, config.agent, checks, config.autoMergeOnGreen, config.mergeMethod);
  state.mrIid = mr.iid;
  state.phase = 'mr';
  recordEvent(repoRoot, state, `Opened MR/PR ${mr.webUrl} for adopted branch ${branch}`);
  return state as ResumableRunState;
}

/**
 * Which recovery path `pipeline-worker resume` should take for this branch.
 * `adopt` carries why it was chosen so the caller can explain itself: "you
 * never ran this branch" and "your run died before it opened anything" are
 * the same recovery but very different news.
 */
export type AdoptReason = 'no-state' | 'no-mr-recorded';

export type ResumeMode =
  | { kind: 'resume'; state: ResumableRunState }
  | { kind: 'adopt'; target: string | undefined; reason: AdoptReason };

/**
 * A state file with no `mrIid` used to *block* resuming — which made having
 * one strictly worse than having none, since a branch pipeline-worker had
 * never seen would happily go down the adoption path. That is exactly
 * backwards for the case it hits hardest: a run that pushed its branch and
 * then died before the MR/PR existed (the forge 500s, the process is killed,
 * the network drops). The branch is on origin, the work is safe, and adoption
 * is precisely the code that turns such a branch into an open MR/PR — so fall
 * through to it instead of refusing.
 *
 * The dead run's target branch is reused when the caller passed no --target,
 * so recovery lands on the same base the original run had chosen.
 */
export function resolveResumeMode(state: RunState | undefined, targetOverride: string | undefined): ResumeMode {
  if (state?.mrIid !== undefined) return { kind: 'resume', state: state as ResumableRunState };
  return {
    kind: 'adopt',
    target: targetOverride || state?.targetBranch || undefined,
    reason: state ? 'no-mr-recorded' : 'no-state',
  };
}

/** Why this branch is being adopted, in the user's terms — the two cases look identical from here on, but arriving at one of them is news. */
function adoptionHeadline(branch: string, reason: AdoptReason): { title: string; detail: string } {
  return reason === 'no-mr-recorded'
    ? {
        title: 'Adopting a stalled run',
        detail: `a previous run for ${branch} died before opening an MR/PR — picking the branch up as origin has it`,
      }
    : { title: 'Adopting external branch', detail: `${branch} has no pipeline-worker run recorded for it — checking it out` };
}

export async function adoptBranch(
  repoRoot: string,
  config: PipelineWorkerConfig,
  forge: ForgeClient,
  agent: AgentAdapter,
  branch: string,
  targetOverride: string | undefined,
  reason: AdoptReason = 'no-state',
): Promise<ResumableRunState> {
  const headline = adoptionHeadline(branch, reason);
  announce(headline.title, headline.detail);

  const worktreePath = await runStep('adopt', `fetch + checkout origin/${branch}`, () =>
    checkoutExistingBranch(repoRoot, branch),
  );

  const state: RunState = { branch, targetBranch: '', worktreePath, ciFixAttempt: 0, conflictAttempt: 0, phase: 'intent' };
  recordEvent(repoRoot, state, `Adopted external branch ${branch} into worktree ${worktreePath}`);

  try {
    const existingMr = await forge.findExistingMr(branch);
    if (existingMr) {
      note(`found existing MR/PR ${existingMr.webUrl}`);
      return await adoptWithExistingMr(agent, config, forge, worktreePath, state, repoRoot, existingMr, targetOverride);
    }
    return await adoptWithoutMr(agent, config, forge, worktreePath, state, repoRoot, branch, targetOverride);
  } catch (error) {
    // The caller can only register cleanup once this returns a state, so a
    // failure in here (checks fail, the forge is down, the agent errors) would
    // otherwise strand the worktree — and git refuses to check the same branch
    // out again while one holds it, so a single leak blocks *every* retry with
    // "is already used by worktree". No MR/PR exists at this point, so there is
    // nothing a preserved worktree could be resumed into either.
    await removeWorktree(repoRoot, worktreePath);
    throw error;
  }
}
