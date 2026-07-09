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
import { checkoutExistingBranch } from '../git/worktree.js';
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
    forge.updateMrDescription(existingMr.iid, buildDescription(intent, config.agent, [])),
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

export async function adoptBranch(
  repoRoot: string,
  config: PipelineWorkerConfig,
  forge: ForgeClient,
  agent: AgentAdapter,
  branch: string,
  targetOverride: string | undefined,
): Promise<ResumableRunState> {
  announce('Adopting external branch', `${branch} has no pipeline-worker run recorded for it — checking it out`);

  const worktreePath = await runStep('adopt', `fetch + checkout origin/${branch}`, () =>
    checkoutExistingBranch(repoRoot, branch),
  );

  const state: RunState = { branch, targetBranch: '', worktreePath, ciFixAttempt: 0, conflictAttempt: 0, phase: 'intent' };
  recordEvent(repoRoot, state, `Adopted external branch ${branch} into worktree ${worktreePath}`);

  const existingMr = await forge.findExistingMr(branch);
  if (existingMr) {
    note(`found existing MR/PR ${existingMr.webUrl}`);
    return adoptWithExistingMr(agent, config, forge, worktreePath, state, repoRoot, existingMr, targetOverride);
  }
  return adoptWithoutMr(agent, config, forge, worktreePath, state, repoRoot, branch, targetOverride);
}
