/**
 * Stage 14 (gated on config.autoMergeOnGreen): once the forge has actually
 * auto-merged the MR/PR, bring the user's own repo up to date — wait for the
 * forge to confirm the merge, give its target-branch ref a few seconds to
 * settle, then fast-forward repoRoot's checked-out target branch from origin
 * so the merged result is already on the user's local main when the run ends.
 *
 * Best-effort by design, like maybeSquashCommits: the run has already
 * succeeded by the time this stage runs, so nothing here may fail it. Every
 * way this can go sideways (auto-merge held up by required approvals, the
 * user switched branches mid-run, a dirty/diverged local target branch that
 * refuses a fast-forward) degrades to a note telling the user to `git pull`
 * themselves.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentBranch } from '../git/commit.js';
import { runStep, skipStep, updateStep, note, noteRisk } from '../ui/steps.js';
import type { ForgeClient } from '../forge/types.js';
import type { PipelineWorkerConfig } from '../types.js';

const execFileAsync = promisify(execFile);

/** All delays in one injectable bundle so tests never wait out real seconds. */
export interface SyncTiming {
  /** How often to re-ask the forge whether the MR/PR has actually merged. */
  pollMs: number;
  /** Give up waiting for the merge after this long — auto-merge can be held indefinitely by required approvals, and this stage must not hang the run on that. */
  timeoutMs: number;
  /** Grace delay between the forge confirming the merge and fetching, so the freshly written target-branch ref is what the fetch actually sees. */
  settleMs: number;
}

export const DEFAULT_SYNC_TIMING: SyncTiming = { pollMs: 3000, timeoutMs: 60000, settleMs: 3000 };

export type SyncOutcome = 'updated' | 'merge-timeout' | 'not-on-target-branch';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls forge.isMrMerged until it confirms, or timing.timeoutMs elapses (false — the MR/PR never merged within the window). */
async function waitForMerge(forge: ForgeClient, mrIid: number, timing: SyncTiming): Promise<boolean> {
  const deadline = Date.now() + timing.timeoutMs;
  for (;;) {
    if (await forge.isMrMerged(mrIid)) return true;
    if (Date.now() + timing.pollMs > deadline) return false;
    await sleep(timing.pollMs);
  }
}

/**
 * The stage's actual work, throwing on git failures (a dirty or diverged
 * local target branch makes `merge --ff-only` refuse) — the wrapper below
 * catches those. `--ff-only` is what makes this safe to run against the
 * user's own repo: it can only ever move the branch forward onto what origin
 * already has, never create a merge commit or touch conflicting local work.
 */
export async function syncTargetBranchAfterMerge(
  forge: ForgeClient,
  repoRoot: string,
  targetBranch: string,
  mrIid: number,
  timing: SyncTiming = DEFAULT_SYNC_TIMING,
): Promise<SyncOutcome> {
  if (!(await waitForMerge(forge, mrIid, timing))) return 'merge-timeout';
  await sleep(timing.settleMs);
  if ((await currentBranch(repoRoot)) !== targetBranch) return 'not-on-target-branch';
  await execFileAsync('git', ['fetch', 'origin', targetBranch], { cwd: repoRoot });
  await execFileAsync('git', ['merge', '--ff-only', `origin/${targetBranch}`], { cwd: repoRoot });
  return 'updated';
}

/** Explains each outcome on the merge step's own row and as a note; every non-'updated' branch ends in "you can still just git pull". */
function reportOutcome(outcome: SyncOutcome, targetBranch: string, timing: SyncTiming): void {
  if (outcome === 'updated') {
    updateStep('merge', { detail: `merged + local ${targetBranch} synced` });
    note(`local ${targetBranch} now includes the merged MR/PR`);
  } else if (outcome === 'merge-timeout') {
    updateStep('merge', { detail: `not merged after ${Math.round(timing.timeoutMs / 1000)}s — git pull ${targetBranch} once it lands` });
    note(
      `the forge had not merged the MR/PR after ${Math.round(timing.timeoutMs / 1000)}s (required approvals still pending?) — ` +
        `run 'git pull' on ${targetBranch} once it merges`,
    );
  } else {
    updateStep('merge', { detail: `repo no longer on ${targetBranch} — git pull it yourself` });
    note(`your repo is no longer on ${targetBranch} — skipped; run 'git pull' on ${targetBranch} yourself`);
  }
}

/** Step 'merge': announces the skip when auto-merge is off, otherwise runs the sync and reduces any failure to a low-risk note. */
export async function maybeSyncTargetBranch(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  repoRoot: string,
  targetBranch: string,
  mrIid: number,
  timing: SyncTiming = DEFAULT_SYNC_TIMING,
): Promise<void> {
  if (!config.autoMergeOnGreen) {
    skipStep('merge', 'config.autoMergeOnGreen is disabled — nothing was merged for this run to pull back');
    return;
  }
  try {
    const outcome = await runStep(
      'merge',
      `wait for the forge to auto-merge the MR/PR, then fast-forward ${targetBranch} from origin`,
      () => syncTargetBranchAfterMerge(forge, repoRoot, targetBranch, mrIid, timing),
    );
    reportOutcome(outcome, targetBranch, timing);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    noteRisk('low', `could not fast-forward local ${targetBranch} (${message}) — run 'git pull' there yourself`);
  }
}
