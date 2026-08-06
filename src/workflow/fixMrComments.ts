/**
 * The stage behind `pipeline-worker fix --branch X`: take the comments already
 * on the branch's open MR/PR — humans, CodeRabbit, SonarQube, Checkmarx, any
 * bot — and act on them, rather than only answering them as review's reply
 * stage does (workflow/replyMrComments.ts).
 *
 * Valid comments are fixed in the code, verified locally, committed and pushed
 * onto the same branch, and answered with the commit that carries the fix.
 * Invalid ones are answered with the reason they do not hold, and nothing is
 * edited for them. What counts as either is decided in review/commentFixes.ts.
 *
 * Deliberately *not* a best-effort stage: acting on comments is the whole
 * command, so a failure here fails the command instead of being reduced to a
 * note. Two consequences follow, and both matter more than the tidy path:
 *
 *   - Nothing is pushed until build/lint/test pass in the worktree. A failing
 *     check aborts before the push, so a broken "fix" never reaches the branch.
 *   - A thread the agent claims to have fixed while leaving the tree untouched
 *     is dropped, not posted. A reply pointing at a commit that does not exist
 *     is worse than no reply.
 */

import { reviewTurnLimits } from './reviewMr.js';
import { runChecks } from './runChecks.js';
import { commit, execGit, hasChanges, mergeBase, push, stageAll } from '../git/commit.js';
import { diffTextSinceRef } from '../git/diff.js';
import { chunkDiff } from '../review/chunkDiff.js';
import {
  COMMENT_FIX_SCHEMA,
  COMMENT_FIX_SYSTEM,
  buildCommentFixPrompt,
  gateFixes,
  parseFixes,
  renderFixBody,
  type PreparedFix,
} from '../review/commentFixes.js';
import { isOwnComment, scannerLabel } from '../review/commentReplies.js';
import { renderSections, suggestionFence } from '../review/prompt.js';
import { note, noteSession, runStep, skipStep } from '../ui/steps.js';
import type { AgentAdapter } from '../agent/types.js';
import type { ForgeClient, MrComment } from '../forge/types.js';
import type { PipelineWorkerConfig } from '../types.js';

/** What the command reports, and what its tests assert on. */
export interface FixOutcome {
  /** Threads answered with a code change that was actually pushed. */
  fixed: number;
  /** Threads answered with a rebuttal instead of a change. */
  refuted: number;
  /** Replies that landed on the forge (fixed + refuted, minus what the forge rejected). */
  posted: number;
  /** Short sha of the commit carrying the fixes, absent when nothing was changed. */
  sha?: string;
}

const EMPTY: FixOutcome = { fixed: 0, refuted: 0, posted: 0 };

/** Threads worth acting on: everything open except pipeline-worker's own comments, replies and fixes. */
function actionable(comments: MrComment[]): MrComment[] {
  return comments.filter((comment) => !isOwnComment(comment) && comment.body.trim().length > 0);
}

/** One line naming what was found, so the run tree says whether bot output was part of it. */
function describeThreads(comments: MrComment[]): string {
  const scanners = [...new Set(comments.map(scannerLabel).filter((label): label is string => label !== undefined))];
  return `${comments.length} open comment thread(s)${scanners.length > 0 ? ` (incl. ${scanners.join(' · ')})` : ''}`;
}

async function shortHeadSha(worktreePath: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--short', 'HEAD'], { cwd: worktreePath });
  return stdout.trim();
}

/** Asks the agent to work through every thread, editing the worktree for the ones it accepts. */
async function decideFixes(
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  targetBranch: string,
  comments: MrComment[],
): Promise<PreparedFix[]> {
  const limits = reviewTurnLimits(config);
  const base = await mergeBase(worktreePath, `origin/${targetBranch}`);
  const chunks = chunkDiff(await diffTextSinceRef(worktreePath, base), limits.maxChars);
  // One turn, whatever the diff's size: a decision is only defensible with the
  // whole set of threads in front of the agent, so the diff is what gets
  // clipped rather than the discussion being split across turns.
  const sections = renderSections(chunks).slice(0, limits.maxChars);

  // No allowedTools: unlike the read-only review turn, this one edits files and
  // legitimately needs to run the project's own commands to check its work.
  const result = await agent.invoke({
    prompt: buildCommentFixPrompt(comments, sections, suggestionFence(config.forge)),
    systemPrompt: COMMENT_FIX_SYSTEM,
    cwd: worktreePath,
    jsonSchema: COMMENT_FIX_SCHEMA,
    permissionMode: 'acceptEdits',
    ...(config.reviewModel ? { model: config.reviewModel } : {}),
  });
  noteSession(result, worktreePath);
  return gateFixes(parseFixes(result.text), comments, config.reviewMaxComments);
}

/** Verifies the edits, then commits and pushes them. Throws before pushing when a check fails. */
async function commitAndPushFixes(
  config: PipelineWorkerConfig,
  worktreePath: string,
  branch: string,
  mrIid: number,
  fixedCount: number,
): Promise<string> {
  await runStep('checks', 'build · lint · test — a broken fix must never reach the branch', async () => {
    const failed = (await runChecks(config, worktreePath)).find((check) => !check.ok);
    if (failed) {
      throw new Error(`${failed.name} fails after the comment fixes — nothing pushed. Worktree edits were discarded; re-run once ${failed.name} can pass.`);
    }
  });
  return runStep('push', `commit the fixes and push ${branch} to origin`, async () => {
    await stageAll(worktreePath);
    await commit(worktreePath, `fix: address ${fixedCount} review comment(s) on !${mrIid}`);
    const sha = await shortHeadSha(worktreePath);
    await push(worktreePath, 'origin', branch);
    note(`pushed ${sha} to ${branch}`);
    return sha;
  });
}

/** Posts each reply individually — one rejected thread must not cost the replies that would still land. */
async function postFixReplies(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  mrIid: number,
  prepared: PreparedFix[],
  sha: string | undefined,
): Promise<number> {
  let posted = 0;
  for (const entry of prepared) {
    try {
      await forge.replyToComment(mrIid, entry.comment.id, renderFixBody(entry, config.forge, config.agent, sha));
      posted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      note(`could not reply to @${entry.comment.author}'s comment — ${message}`);
    }
  }
  return posted;
}

/**
 * Fixes what the MR/PR's comments ask for and answers all of them. Rejects
 * when the branch's checks fail after the agent's edits (nothing is pushed in
 * that case) or when the forge cannot be read.
 */
export async function fixMrComments(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  branch: string,
  targetBranch: string,
  mrIid: number,
): Promise<FixOutcome> {
  const comments = await runStep('comments', 'read the open comment threads on the MR/PR', async () => {
    const found = actionable(await forge.listMrComments(mrIid));
    note(found.length === 0 ? 'no open comments to act on' : `reading ${describeThreads(found)}`);
    return found;
  });
  if (comments.length === 0) {
    for (const id of ['fix', 'checks', 'push', 'replies']) skipStep(id, 'nothing to act on');
    return EMPTY;
  }

  const prepared = await runStep('fix', `${config.agent} fixes what the comments got right`, () =>
    decideFixes(config, agent, worktreePath, targetBranch, comments),
  );
  const edited = await hasChanges(worktreePath);
  // A "fixed" claim with an untouched tree is dropped rather than posted: the
  // reply would point at a commit that carries nothing for that thread.
  const kept = prepared.filter((entry) => entry.fix.action === 'invalid' || edited);
  const dropped = prepared.length - kept.length;
  if (dropped > 0) note(`dropped ${dropped} "fixed" claim(s) — the agent changed no files`);
  if (kept.length === 0) {
    for (const id of ['checks', 'push', 'replies']) skipStep(id, 'nothing to fix and nothing to refute');
    return EMPTY;
  }

  const fixed = kept.filter((entry) => entry.fix.action === 'fixed');
  let sha: string | undefined;
  if (fixed.length > 0) {
    sha = await commitAndPushFixes(config, worktreePath, branch, mrIid, fixed.length);
  } else {
    for (const id of ['checks', 'push']) skipStep(id, 'every comment was refuted — no code changed');
  }

  const posted = await runStep('replies', 'answer each thread: what was fixed, and what does not hold', async () => {
    const landed = await postFixReplies(forge, config, mrIid, kept, sha);
    note(`answered ${landed} of ${kept.length} comment thread(s)`);
    return landed;
  });
  return { fixed: fixed.length, refuted: kept.length - fixed.length, posted, ...(sha ? { sha } : {}) };
}
