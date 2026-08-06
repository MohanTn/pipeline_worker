/**
 * Answers the comment threads already on an MR/PR — the companion stage to
 * reviewMr.ts, which only adds new ones. Run by `pipeline-worker review
 * --branch X`, where asking for a review explicitly is the opt-in; the
 * automatic review inside `run`/`resume` does not do this, since a run that
 * just opened its own MR/PR has nothing there to answer yet.
 *
 * What it answers, and how, is decided in review/commentReplies.ts. What it
 * skips is decided here: threads pipeline-worker itself wrote (recognized by
 * their own footer), which is what keeps repeated `review` runs from arguing
 * with themselves. Resolved threads never reach this code — both forge
 * implementations drop them in listMrComments.
 *
 * Best-effort under CLAUDE.md's never-throw contract: an unreachable
 * merge-base, a forge that will not list comments, an agent answering with
 * prose, a rejected reply — each is reduced to a note.
 */

import { reviewTurnLimits, type ReviewOutcome } from './reviewMr.js';
import { mergeBase } from '../git/commit.js';
import { diffTextSinceRef } from '../git/diff.js';
import { chunkDiff } from '../review/chunkDiff.js';
import {
  COMMENT_REPLY_SCHEMA,
  COMMENT_REPLY_SYSTEM,
  buildCommentReplyPrompt,
  gateReplies,
  isOwnComment,
  parseReplies,
  renderReplyBody,
  scannerLabel,
  type PreparedReply,
} from '../review/commentReplies.js';
import { renderSections, suggestionFence } from '../review/prompt.js';
import { note, noteSession, runStep } from '../ui/steps.js';
import type { AgentAdapter } from '../agent/types.js';
import type { ForgeClient, MrComment } from '../forge/types.js';
import type { PipelineWorkerConfig } from '../types.js';

/** Same read-only stance as the review turn: the reviewer may look a caller up, never edit what it is reviewing. */
const REPLY_TOOLS = ['Read'];

/** Posts each reply individually — one rejected thread must not cost the replies that would still land. */
export async function postReplies(forge: ForgeClient, mrIid: number, prepared: PreparedReply[], config: PipelineWorkerConfig): Promise<number> {
  let posted = 0;
  for (const entry of prepared) {
    try {
      await forge.replyToComment(mrIid, entry.comment.id, renderReplyBody(entry, config.forge, config.agent));
      posted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      note(`could not reply to @${entry.comment.author}'s comment — ${message}`);
    }
  }
  return posted;
}

/** Threads a reviewer could answer: everything open except pipeline-worker's own comments and replies. */
function answerable(comments: MrComment[]): MrComment[] {
  return comments.filter((comment) => !isOwnComment(comment) && comment.body.trim().length > 0);
}

/** One line naming what was found, so the run tree says whether scanner output was part of it. */
function describeThreads(comments: MrComment[]): string {
  const scanners = [...new Set(comments.map(scannerLabel).filter((label): label is string => label !== undefined))];
  return `${comments.length} open comment thread(s)${scanners.length > 0 ? ` (incl. ${scanners.join(' · ')})` : ''}`;
}

/**
 * Answers what is already on the MR/PR. `posted` is 0 when there is nothing to
 * answer, nothing survived the gate, or anything failed. Never rejects.
 *
 * `clean` (see reviewMr.ts's ReviewOutcome) is this stage's verdict on the
 * discussion: a `support` reply means the agent read a comment and agreed the
 * problem is real, which is exactly the thing an approval must not paper over.
 * A `correct` reply is the opposite — the point was raised and refuted — so it
 * leaves the verdict clean.
 */
export async function maybeReplyToMrComments(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  targetBranch: string,
  mrIid: number,
): Promise<ReviewOutcome> {
  try {
    return await runStep('replies', `${config.agent} answers the comments already on the MR/PR`, async () => {
      const comments = answerable(await forge.listMrComments(mrIid));
      if (comments.length === 0) {
        note('no open comments to answer');
        return { posted: 0, clean: true };
      }

      const limits = reviewTurnLimits(config);
      const base = await mergeBase(worktreePath, `origin/${targetBranch}`);
      const chunks = chunkDiff(await diffTextSinceRef(worktreePath, base), limits.maxChars);
      // One turn, whatever the diff's size: a reply is only defensible with the
      // whole set of threads in front of the agent, so the diff is what gets
      // clipped here rather than the discussion being split across turns.
      const sections = renderSections(chunks).slice(0, limits.maxChars);
      note(`reading ${describeThreads(comments)}`);

      const result = await agent.invoke({
        prompt: buildCommentReplyPrompt(comments, sections, config.reviewMinSeverity, suggestionFence(config.forge)),
        systemPrompt: COMMENT_REPLY_SYSTEM,
        cwd: worktreePath,
        jsonSchema: COMMENT_REPLY_SCHEMA,
        permissionMode: 'default',
        allowedTools: REPLY_TOOLS,
        ...(config.reviewModel ? { model: config.reviewModel } : {}),
      });
      noteSession(result, worktreePath);

      const prepared = gateReplies(parseReplies(result.text), comments, config.reviewMinSeverity, config.reviewMaxComments);
      if (prepared.length === 0) {
        note('nothing in those comments needs an answer');
        return { posted: 0, clean: true };
      }

      const posted = await postReplies(forge, mrIid, prepared, config);
      note(`replied to ${posted} of ${prepared.length} comment thread(s)`);
      return { posted, clean: !prepared.some((entry) => entry.reply.kind === 'support') };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(`comment replies skipped: ${message}`);
    return { posted: 0, clean: false };
  }
}
