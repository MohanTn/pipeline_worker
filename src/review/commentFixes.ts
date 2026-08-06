/**
 * The decision layer of `pipeline-worker fix --branch X`: read the comment
 * threads already on an MR/PR — humans and bots alike (CodeRabbit, SonarQube,
 * Checkmarx, …) — and decide, per thread, whether to *change the code* or to
 * push back.
 *
 * Two outcomes, and only two:
 *
 *   fixed   — the comment is right, and the agent has edited the branch so it
 *             no longer applies. The reply names what changed, and the stage
 *             (workflow/fixMrComments.ts) appends the commit that carries it.
 *   invalid — the comment is wrong, points at the wrong place, or recommends
 *             something that must not be done here (the common case for a
 *             scanner false positive). Nothing is edited; the reply opens with
 *             "This is not recommended because:" and gives the reason.
 *
 * The severity floor deliberately does not gate anything here: `fix` is asked
 * for explicitly, and a comment worth a human's time to write is worth
 * answering whatever its severity. Severity survives only as the label on the
 * reply.
 *
 * Agent output is untrusted exactly as in commentReplies.ts — zod first, then
 * the gate — and `thread` is an index into the list the prompt rendered, never
 * a forge id, so a hallucinated id cannot redirect a reply onto another thread.
 */

import { z } from 'zod';
import { normalizeSuggestionFence } from './findings.js';
import { CORRECTION_LEAD, extractJson, renderThreads } from './commentReplies.js';
import { SEVERITY_RANK, type ReviewSeverity } from './types.js';
import type { MrComment } from '../forge/types.js';
import type { ForgeName } from '../types.js';

export type FixAction = 'fixed' | 'invalid';

export interface CommentFix {
  /** 1-based position in the thread list the prompt rendered. */
  thread: number;
  action: FixAction;
  severity: ReviewSeverity;
  /** What was changed ("fixed"), or why the comment does not hold ("invalid"). */
  message: string;
}

/** A decision paired with the thread it answers — what the poster needs and all it needs. */
export interface PreparedFix {
  comment: MrComment;
  fix: CommentFix;
}

export const COMMENT_FIX_SYSTEM =
  'You are an elite, pragmatic Staff Software Engineer working through the review comments on your own merge request. ' +
  'You have write access to the checked-out branch: when a comment is right, you edit the code so it no longer applies, ' +
  'and when it is wrong you leave the code alone and say why. You judge every claim on its merits, including an ' +
  'automated scanner\'s — scanners report false positives, and silently "fixing" one makes the code worse.';

export const COMMENT_FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      description: 'One entry per thread you acted on. Empty when no thread needed either a code change or a rebuttal.',
      items: {
        type: 'object',
        properties: {
          thread: { type: 'number', description: 'The number of the thread being answered, copied from its "### Thread N" header.' },
          action: {
            type: 'string',
            enum: ['fixed', 'invalid'],
            description:
              'fixed: you edited the code in this working tree so the comment no longer applies. invalid: the comment is wrong, points at the wrong place, or recommends something that must not be done here — you changed nothing.',
          },
          severity: {
            type: 'string',
            enum: ['CRITICAL', 'MAJOR', 'MINOR'],
            description:
              'For "fixed", how bad the problem was. For "invalid", how much damage following the comment would have done. CRITICAL: data loss, security hole, or guaranteed crash. MAJOR: a real bug or serious design defect. MINOR: everything else.',
          },
          message: {
            type: 'string',
            description:
              'Markdown, addressed to the thread. For "fixed", name the files and the change you made. For "invalid", give the reason the comment does not hold and, when you know it, the right place or the right fix instead.',
          },
        },
        required: ['thread', 'action', 'severity', 'message'],
      },
    },
  },
  required: ['fixes'],
} as const;

/**
 * `diffSections` is the same rendered branch diff the review stage works from,
 * so a claim can be checked against the code, but the agent is explicitly told
 * to read the real files before editing: the diff shows changed lines only.
 */
export function buildCommentFixPrompt(comments: MrComment[], diffSections: string, fence: string): string {
  return (
    'Below are the open comment threads on a merge request, followed by the diff they are about. The branch is ' +
    'checked out in your working directory. Work through every thread.\n\n' +
    'CRITICAL INSTRUCTIONS:\n' +
    '1. When a thread is right, FIX IT IN THE CODE: read the file it points at, make the smallest correct change, and ' +
    'report that thread with action "fixed" and a message naming the files you touched. Do not commit, do not push, ' +
    'do not create branches — leave the edits in the working tree.\n' +
    '2. When a thread is wrong — it misreads the code, points at a line that is not the cause, is already handled, or ' +
    'recommends a change that must not be made here (a scanner false positive counts) — change NOTHING and report it ' +
    `with action "invalid". Its message MUST begin with the exact words "${CORRECTION_LEAD}" and then give the reason.\n` +
    '3. Never report a thread as "fixed" unless you actually edited a file for it. An unverifiable claim is worse than ' +
    'no reply.\n' +
    '4. Keep existing behaviour and the project\'s conventions intact. If a fix would need a design decision or touches ' +
    'code the comment did not ask about, do not make it — report the thread as "invalid" explaining what you would need.\n' +
    `5. When a code change fits on the lines under discussion, you may also append a suggestion block to the message:\n${fence}\n<corrected code>\n\`\`\`\n` +
    '6. Set "thread" to the number in the "### Thread N" header of the thread you are answering.\n\n' +
    '### Open comment threads:\n' +
    `${renderThreads(comments)}\n\n` +
    '### Git Diff Data (gutter = line number in the new file):\n' +
    `${diffSections}\n`
  );
}

const FixShape = z.object({
  thread: z.number().int().positive(),
  action: z.enum(['fixed', 'invalid']),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  message: z.string().min(1),
});

const PayloadShape = z.union([z.object({ fixes: z.array(FixShape) }), z.array(FixShape)]);

/** Never throws: an unusable payload means no decisions, not a failed run. */
export function parseFixes(text: string): CommentFix[] {
  const json = extractJson(text);
  if (!json) return [];
  try {
    const parsed = PayloadShape.parse(JSON.parse(json));
    return Array.isArray(parsed) ? parsed : parsed.fixes;
  } catch {
    return [];
  }
}

/** Drops a thread number the prompt never showed, keeps one decision per thread, and caps the run — severest first. */
export function gateFixes(fixes: CommentFix[], comments: MrComment[], maxFixes: number): PreparedFix[] {
  const seen = new Set<number>();
  const kept: PreparedFix[] = [];
  for (const fix of fixes) {
    const comment = comments[fix.thread - 1];
    if (!comment) continue;
    if (seen.has(fix.thread)) continue;
    seen.add(fix.thread);
    kept.push({ comment, fix });
  }
  return kept.sort((a, b) => SEVERITY_RANK[b.fix.severity] - SEVERITY_RANK[a.fix.severity]).slice(0, Math.max(0, maxFixes));
}

/**
 * The body actually posted. Same three jobs as commentReplies.ts's
 * renderReplyBody — quote the original when the forge cannot thread under it,
 * enforce the opening the agent was asked for, and sign it so a later run
 * recognizes the thread as answered — plus the one thing only this stage can
 * say: the commit the fix landed in.
 */
export function renderFixBody(prepared: PreparedFix, forge: ForgeName, agentName: string, sha?: string): string {
  const { comment, fix } = prepared;
  const quote = comment.threadable ? '' : `> Replying to ${comment.url ? `[@${comment.author}'s comment](${comment.url})` : `@${comment.author}'s comment`}\n\n`;
  const text = fix.message.trim();
  const lead =
    fix.action === 'invalid'
      ? text.toLowerCase().startsWith(CORRECTION_LEAD.toLowerCase())
        ? ''
        : `${CORRECTION_LEAD} `
      : `Fixed${sha ? ` in \`${sha}\`` : ''}: `;
  return `${quote}${lead}${normalizeSuggestionFence(text, forge)}\n\n_${fix.severity} · pipeline-worker fix (${agentName})_`;
}
