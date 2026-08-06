/**
 * The last stage of `pipeline-worker review --branch X`: record an approval on
 * the MR/PR when the two stages before it came back clean. Deliberately absent
 * from `run`/`resume` — a run that just wrote the diff approving its own MR/PR
 * would be a rubber stamp, not a review.
 *
 * "Clean" is decided by the stages themselves (reviewMr.ts's ReviewOutcome),
 * and is affirmative: the review looked at a real diff and raised nothing at or
 * above reviewMinSeverity, and the discussion held nothing the agent had to
 * confirm. A stage that failed, was skipped, or could not post what it found is
 * never clean, so a silent failure can never become an approval. The one thing
 * checked here rather than there is merge conflicts, which neither stage looks
 * at and which no reviewer should approve past.
 *
 * Best-effort under CLAUDE.md's never-throw contract: both forges reject
 * approvals for reasons no caller can fix (GitHub bars approving your own PR,
 * GitLab's approvals API is paid-tier), so a rejection is a note.
 */

import { note, runStep, skipStep } from '../ui/steps.js';
import type { ForgeClient } from '../forge/types.js';
import type { PipelineWorkerConfig } from '../types.js';

/** True only when the approval actually landed on the forge. Never rejects. */
export async function maybeApproveMergeRequest(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  mrIid: number,
  clean: boolean,
): Promise<boolean> {
  if (!config.reviewApprove) {
    skipStep('approve', 'reviewApprove is disabled — approving stays a human act');
    return false;
  }
  if (!clean) {
    skipStep('approve', 'the review left something to address — approving is the human reviewer\'s call');
    return false;
  }

  try {
    return await runStep('approve', 'nothing to flag — approve the MR/PR', async () => {
      // Asked after the review rather than before it: the comments are worth
      // posting either way, and only the approval is blocked by a conflict.
      if (await forge.hasMergeConflicts(mrIid)) {
        note('not approving: the MR/PR has merge conflicts against its target branch');
        return false;
      }
      await forge.approveMr(mrIid);
      note('approved');
      return true;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(`approval skipped: ${message}`);
    return false;
  }
}
