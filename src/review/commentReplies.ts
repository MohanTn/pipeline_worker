/**
 * The second half of the review feature: instead of only *adding* comments to
 * an MR/PR, read the threads already on it — human review comments and scanner
 * findings (SonarQube, Checkmarx, …) — and answer the ones worth answering.
 *
 * Two kinds of answer, and only two:
 *
 *   support — the thread names a real problem in this diff, at or above the
 *             configured severity floor. The reply confirms it and says what
 *             the fix is, so the author does not have to re-derive it.
 *   correct — the thread points at the wrong place, or recommends something
 *             that should not be done here (a scanner false positive, a
 *             suggestion that breaks something else). The reply opens with
 *             "This is not recommended because:" and gives the reason.
 *
 * The severity floor gates `support` only. A misdirection is corrected
 * whatever its severity: a wrong steer left standing costs the author time
 * regardless of how serious the thing it points at would have been.
 *
 * Agent output is untrusted here exactly as in findings.ts — zod first, then
 * the gate — and the thread a reply names is an index into the list the prompt
 * showed, not a forge id, so a hallucinated id can never redirect a reply onto
 * an unrelated thread.
 */

import { z } from 'zod';
import { normalizeSuggestionFence } from './findings.js';
import { SEVERITY_RANK, type ReviewSeverity } from './types.js';
import type { MrComment } from '../forge/types.js';
import type { ForgeName } from '../types.js';

export type ReplyKind = 'support' | 'correct';

export interface CommentReply {
  /** 1-based position in the thread list the prompt rendered. */
  thread: number;
  kind: ReplyKind;
  severity: ReviewSeverity;
  reply: string;
}

/** A reply paired with the thread it answers — what the poster needs and all it needs. */
export interface PreparedReply {
  comment: MrComment;
  reply: CommentReply;
}

/**
 * Footer every comment and reply pipeline-worker posts carries. Also the
 * re-entry guard: a thread whose text already contains it was answered by a
 * previous run, and answering it again is how a bot becomes noise.
 */
const OWN_COMMENT_MARKER = /pipeline-worker (review|reply) \(/;

/** The opening a correction must carry, so a reader sees the verdict before the reasoning. */
export const CORRECTION_LEAD = 'This is not recommended because:';

/** Long scanner dumps are common; a thread is worth this much of the prompt and no more. */
const MAX_THREAD_CHARS = 4_000;

const SCANNERS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'SonarQube', pattern: /sonar(qube|cloud)?/i },
  { label: 'Checkmarx', pattern: /checkmarx|\bcx[-_ ]?(one|flow|sast)\b/i },
];

/** True for a thread pipeline-worker itself wrote — its own review comment, or an earlier reply. */
export function isOwnComment(comment: MrComment): boolean {
  return OWN_COMMENT_MARKER.test(comment.body);
}

/**
 * Which scanner produced this thread, if any. Checked against the author first
 * (the usual case: a bot account) and the body second, since both forges let a
 * scanner post through a generic CI token whose login says nothing.
 */
export function scannerLabel(comment: MrComment): string | undefined {
  return SCANNERS.find((scanner) => scanner.pattern.test(comment.author) || scanner.pattern.test(comment.body))?.label;
}

export const COMMENT_REPLY_SYSTEM =
  'You are an elite, pragmatic Staff Software Engineer reviewing an open merge request. You are answering the ' +
  'comments other people and automated scanners have already left on it. You are decisive and specific: you confirm ' +
  'a real problem and name its fix, or you say plainly that a suggestion should not be followed and why. You never ' +
  'reply just to agree, to thank, or to restate the comment. You judge every claim against the diff you are shown, ' +
  'including a scanner\'s: scanners report false positives, and an unchallenged one costs the author real time.';

export const COMMENT_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      description: 'One entry per thread worth answering. Empty when no thread needs a reply.',
      items: {
        type: 'object',
        properties: {
          thread: { type: 'number', description: 'The number of the thread being answered, copied from its "### Thread N" header.' },
          kind: {
            type: 'string',
            enum: ['support', 'correct'],
            description:
              'support: the thread is right about a real problem in this diff. correct: the thread points at the wrong place, misreads the code, or recommends something that should not be done here.',
          },
          severity: {
            type: 'string',
            enum: ['CRITICAL', 'MAJOR', 'MINOR'],
            description:
              'For "support", how bad the problem the thread found is. For "correct", how much damage following the comment would do. CRITICAL: data loss, security hole, or guaranteed crash. MAJOR: a real bug or serious design defect. MINOR: everything else.',
          },
          reply: {
            type: 'string',
            description:
              'Markdown, addressed to the thread. For "correct" it must begin with "This is not recommended because:" followed by the reason and, when there is one, the right place or the right fix instead.',
          },
        },
        required: ['thread', 'kind', 'severity', 'reply'],
      },
    },
  },
  required: ['replies'],
} as const;

function clip(text: string): string {
  return text.length <= MAX_THREAD_CHARS ? text : `${text.slice(0, MAX_THREAD_CHARS)}\n…[thread truncated]`;
}

/** The thread list as the prompt shows it — the numbering here is the contract the agent's `thread` field answers against. */
export function renderThreads(comments: MrComment[]): string {
  return comments
    .map((comment, index) => {
      const scanner = scannerLabel(comment);
      const anchor = comment.path ? ` on ${comment.path}${comment.line === undefined ? '' : `:${comment.line}`}` : ' (not anchored to a line)';
      const source = scanner ? ` [${scanner} scanner]` : '';
      return `### Thread ${index + 1} — @${comment.author}${source}${anchor}\n${clip(comment.body)}`;
    })
    .join('\n\n');
}

/**
 * `diffSections` is the same rendered diff the review turn works from (see
 * review/prompt.ts's sections), so a claim in a thread can be checked against
 * the code rather than taken on faith.
 */
export function buildCommentReplyPrompt(comments: MrComment[], diffSections: string, minSeverity: ReviewSeverity, fence: string): string {
  return (
    'Below are the open comment threads on a merge request, followed by the diff they are about. Decide, for each ' +
    'thread, whether to reply.\n\n' +
    'CRITICAL INSTRUCTIONS:\n' +
    `1. Reply with kind "support" only when the thread identifies a real problem in this diff whose severity is ${minSeverity} ` +
    'or worse. Confirm what is wrong and give the concrete fix. Anything less serious than that, or already handled in ' +
    'the diff, gets no reply at all.\n' +
    '2. Reply with kind "correct" when the thread sends the author to the wrong place: it points at a line that is not ' +
    'the cause, misreads what the code does, or recommends a change that should not be made here (this includes a ' +
    'scanner false positive). Such a reply MUST begin with the exact words ' +
    `"${CORRECTION_LEAD}" and then give the reason, plus the right place or the right fix when you know it.\n` +
    '3. Say nothing about a thread you would only be agreeing with, thanking, or summarizing. An empty replies list is ' +
    'the correct answer for a merge request whose comments are all already right and already actionable.\n' +
    '4. Base every judgement on the diff below. If the diff does not carry enough evidence to be sure the thread is ' +
    'wrong, do not correct it.\n' +
    `5. When a concrete fix fits on the lines under discussion, append a suggestion block:\n${fence}\n<corrected code>\n\`\`\`\n` +
    '6. Set "thread" to the number in the "### Thread N" header of the thread you are answering.\n\n' +
    '### Open comment threads:\n' +
    `${renderThreads(comments)}\n\n` +
    '### Git Diff Data (gutter = line number in the new file):\n' +
    `${diffSections}\n`
  );
}

const ReplyShape = z.object({
  thread: z.number().int().positive(),
  kind: z.enum(['support', 'correct']),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  reply: z.string().min(1),
});

const PayloadShape = z.union([z.object({ replies: z.array(ReplyShape) }), z.array(ReplyShape)]);

/** Agents wrap JSON in prose or fences often enough to be worth one salvage attempt (same stance as findings.ts). */
function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const start = trimmed.search(/[[{]/);
  if (start === -1) return undefined;
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  return end > start ? trimmed.slice(start, end + 1) : undefined;
}

/** Never throws: an unusable payload means no replies, not a failed review. */
export function parseReplies(text: string): CommentReply[] {
  const json = extractJson(text);
  if (!json) return [];
  try {
    const parsed = PayloadShape.parse(JSON.parse(json));
    return Array.isArray(parsed) ? parsed : parsed.replies;
  } catch {
    return [];
  }
}

/**
 * Applies the gate: a thread number the prompt never showed is dropped, one
 * thread gets at most one reply, `support` must clear the severity floor, and
 * the whole run is capped. A `correct` deliberately ignores the floor — see the
 * file header.
 */
export function gateReplies(replies: CommentReply[], comments: MrComment[], minSeverity: ReviewSeverity, maxReplies: number): PreparedReply[] {
  const floor = SEVERITY_RANK[minSeverity];
  const seen = new Set<number>();
  const kept: PreparedReply[] = [];
  for (const reply of replies) {
    const comment = comments[reply.thread - 1];
    if (!comment) continue;
    if (seen.has(reply.thread)) continue;
    if (reply.kind === 'support' && SEVERITY_RANK[reply.severity] < floor) continue;
    seen.add(reply.thread);
    kept.push({ comment, reply });
  }
  return kept.sort((a, b) => SEVERITY_RANK[b.reply.severity] - SEVERITY_RANK[a.reply.severity]).slice(0, Math.max(0, maxReplies));
}

/**
 * The body actually posted. Three jobs: quote the original when the forge
 * cannot thread the reply under it (GitHub's PR-level comments), enforce the
 * correction opening the agent was asked for but does not reliably produce,
 * and sign it so the next run recognizes this thread as answered.
 */
export function renderReplyBody(prepared: PreparedReply, forge: ForgeName, agentName: string): string {
  const { comment, reply } = prepared;
  const quote = comment.threadable ? '' : `> Replying to ${comment.url ? `[@${comment.author}'s comment](${comment.url})` : `@${comment.author}'s comment`}\n\n`;
  const text = reply.reply.trim();
  const lead = reply.kind === 'correct' && !text.toLowerCase().startsWith(CORRECTION_LEAD.toLowerCase()) ? `${CORRECTION_LEAD} ` : '';
  return `${quote}${lead}${normalizeSuggestionFence(text, forge)}\n\n_${reply.severity} · pipeline-worker reply (${agentName})_`;
}
