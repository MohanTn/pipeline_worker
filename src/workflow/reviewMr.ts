/**
 * Optional stage, run once the MR/PR is open and before CI is watched: ask
 * the agent to review the branch's own diff and post what it finds as
 * line-anchored comments on the MR/PR, so a human opening it sees the
 * concerns next to the code instead of in a wall of description text.
 *
 * A best-effort stage under CLAUDE.md's never-throw contract: an unreachable
 * merge-base, an agent that answers with prose, a forge that rejects a
 * position — each is reduced to a note and the run's outcome is unchanged.
 * Nothing downstream (CI watch, auto-merge, cleanup) depends on it.
 *
 * (Named reviewMr.ts, not reviewMergeRequest.ts as its sibling
 * openMergeRequest.ts would suggest: a `*Request.ts` file name is reserved
 * for generated request boilerplate by a repo-external tooling guard.)
 */

import { mergeBase } from '../git/commit.js';
import { diffTextSinceRef } from '../git/diff.js';
import { chunkDiff } from '../review/chunkDiff.js';
import { normalizeSuggestionFence } from '../review/findings.js';
import { reviewDiff } from '../review/reviewDiff.js';
import { note, runStep, skipStep } from '../ui/steps.js';
import type { AgentAdapter } from '../agent/types.js';
import type { ForgeClient } from '../forge/types.js';
import type { DiffChunk, ReviewFinding } from '../review/types.js';
import type { ForgeName, PipelineWorkerConfig } from '../types.js';

/**
 * A follow-up run (orchestrate.ts's runFollowUpMrStage) adds one commit to an
 * MR/PR that may already carry a long history of reviewed commits. Reviewing
 * the whole branch diff there would re-flag lines a human has already read
 * and possibly resolved, so the caller passes the files *this run* touched
 * and the review is narrowed to them.
 */
export function scopeChunks(chunks: DiffChunk[], scopeFiles: string[] | undefined): DiffChunk[] {
  if (!scopeFiles) return chunks;
  const wanted = new Set(scopeFiles);
  return chunks.filter((chunk) => wanted.has(chunk.path));
}

/** Posts each surviving finding, individually: one rejected position must not cost the comments that would still land. */
export async function postFindings(
  forge: ForgeClient,
  mrIid: number,
  findings: ReviewFinding[],
  forgeName: ForgeName,
  agentName: string,
): Promise<number> {
  let posted = 0;
  for (const finding of findings) {
    const body = `${normalizeSuggestionFence(finding.comment, forgeName)}\n\n_${finding.severity} · pipeline-worker review (${agentName})_`;
    try {
      await forge.createInlineComment(mrIid, { path: finding.file, line: finding.line, body });
      posted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      note(`could not comment on ${finding.file}:${finding.line} — ${message}`);
    }
  }
  return posted;
}

/** Returns how many comments were actually posted — 0 when disabled, when nothing survived the gate, or when anything failed. Never rejects. */
export async function maybeReviewMergeRequest(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  targetBranch: string,
  mrIid: number,
  scopeFiles?: string[],
): Promise<number> {
  if (!config.review) {
    skipStep('review', 'config.review is disabled — set PIPELINE_WORKER_REVIEW=true to have the agent review its own diff');
    return 0;
  }

  try {
    return await runStep('review', `${config.agent} reviews the diff and comments on the lines it flags`, async () => {
      const base = await mergeBase(worktreePath, `origin/${targetBranch}`);
      const chunks = scopeChunks(chunkDiff(await diffTextSinceRef(worktreePath, base), config.reviewChunkChars), scopeFiles);
      if (chunks.length === 0) {
        note('nothing reviewable in this diff (no added lines a comment could anchor to)');
        return 0;
      }

      note(`reviewing ${chunks.length} chunk(s) across ${new Set(chunks.map((chunk) => chunk.path)).size} file(s)`);
      const { findings } = await reviewDiff(agent, chunks, worktreePath, {
        model: config.reviewModel,
        minSeverity: config.reviewMinSeverity,
        maxComments: config.reviewMaxComments,
        forge: config.forge,
      });
      if (findings.length === 0) {
        note(`no findings at or above ${config.reviewMinSeverity} — nothing worth commenting on`);
        return 0;
      }

      const posted = await postFindings(forge, mrIid, findings, config.forge, config.agent);
      note(`posted ${posted} of ${findings.length} review comment(s)`);
      return posted;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(`review skipped: ${message}`);
    return 0;
  }
}
