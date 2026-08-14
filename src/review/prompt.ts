/**
 * The reviewer's instruction, output schema, and per-chunk prompt. Kept apart
 * from reviewDiff.ts so the wording — the thing that decides whether the
 * comments are worth reading — is one readable block rather than string
 * concatenation buried in control flow.
 *
 * Gatekeeping starts here: the instruction narrows the reviewer to logic,
 * security, performance, and severe anti-patterns. findings.ts enforces the
 * rest (severity floor, per-run cap, dedupe) on output that ignores it.
 */

import type { DiffChunk } from './types.js';
import type { ForgeName } from '../types.js';

/**
 * Passed as the turn's *system* prompt (see reviewDiff.ts), not repeated in
 * every chunk's user prompt: with one turn per chunk, restating it each time
 * spent context a small local model cannot spare, and the claude adapter can
 * hand it to `--system-prompt` directly.
 */
export const REVIEW_SYSTEM =
  'You are an elite, pragmatic Staff Software Engineer and Security Auditor. Your task is to review the provided ' +
  'Git diff and generate high-utility, line-specific code review comments. Focus strictly on logical errors, ' +
  'security vulnerabilities, performance bottlenecks, and severe anti-patterns. Do not comment on style, ' +
  'formatting, or missing documentation unless it directly causes a bug. You review the diff you are given and ' +
  'do not read the full contents of the files it changes.';

/**
 * GitHub renders a plain ```suggestion block as a one-click "commit
 * suggestion" button; GitLab needs the line-range form (`-0+0` = "replace
 * this one line"). findings.ts re-checks and rewrites the fence afterwards,
 * since the agent does not reliably honor this.
 */
export function suggestionFence(forge: ForgeName): string {
  return forge === 'gitlab' ? '```suggestion:-0+0' : '```suggestion';
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: 'One entry per actionable issue. Empty when the code is good.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'The file path exactly as given in the chunk header.' },
          line: { type: 'number', description: 'A line number taken verbatim from the left-hand gutter of an added (+) line.' },
          code: { type: 'string', description: 'That same line\'s code, copied verbatim without the gutter and without the leading "+". Used to verify the anchor.' },
          severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'], description: 'CRITICAL: data loss, security hole, or guaranteed crash. MAJOR: a real bug or serious performance/design defect. MINOR: everything else.' },
          comment: { type: 'string', description: 'Markdown: a "### Title" line, the explanation and its impact, then an optional suggestion block with the corrected line(s).' },
        },
        required: ['file', 'line', 'code', 'severity', 'comment'],
      },
    },
  },
  required: ['findings'],
} as const;

/** Each chunk as its own labeled section, so a multi-file turn keeps every line number attributable to one path. Shared with the comment-reply turn (review/commentReplies.ts), which shows the agent the same diff. */
export function renderSections(chunks: DiffChunk[]): string {
  return chunks.map((chunk) => `--- File: ${chunk.path}\n--- Language: ${chunk.language}\n${chunk.body}`).join('\n\n');
}

/**
 * One prompt per *turn*, which may carry several files (see chunkDiff.ts's
 * groupChunks — a cloud model reviews the whole diff in one turn). The diff is
 * rendered with its new-file line numbers in a left gutter and the agent is
 * told to copy one of those numbers verbatim; anything it invents anyway is
 * dropped by findings.ts before it reaches the forge.
 *
 * Each file is a labeled section rather than a single `File:` header, since the
 * finding's `file` must name the section its line came from — a line number is
 * only unique within one file, and a finding attributed to the wrong path is
 * discarded by gatekeep after the agent already paid to produce it.
 *
 * The reviewer's persona lives in REVIEW_SYSTEM, delivered as the turn's
 * system prompt rather than prefixed here, so what follows is only this
 * turn's own instructions and data.
 */
/**
 * The tail of a later round's prompt: what earlier rounds already said about
 * this MR/PR, and the comments that appeared since. Without it a second
 * `review --branch` re-derives the diff cold and re-flags what round 1 posted,
 * which is exactly what the turn history exists to prevent — the dedupe in
 * reviewMr.ts drops those findings afterwards, but only after the agent has
 * been paid to produce them.
 */
export function buildRoundContext(turn: number, alreadyPosted: string[], newThreads: string[]): string {
  if (turn <= 1 || (alreadyPosted.length === 0 && newThreads.length === 0)) return '';
  const posted = alreadyPosted.length > 0 ? `Comments earlier rounds already posted (do not repeat them):\n${alreadyPosted.map((line) => `- ${line}`).join('\n')}\n\n` : '';
  const threads = newThreads.length > 0 ? `Comment threads opened on the merge request since the last round — react to these, and drop any finding they already answer:\n${newThreads.map((body) => `- ${body}`).join('\n')}\n\n` : '';
  return `### Review round ${turn}\n\nThis diff has been reviewed ${turn - 1} time(s) already.\n\n${posted}${threads}`;
}

export function buildReviewPrompt(chunks: DiffChunk[], fence: string, roundContext = ''): string {
  const paths = [...new Set(chunks.map((chunk) => chunk.path))];
  const fileList = paths.length > 1 ? `Files in this diff, all of which you must review:\n${paths.map((path) => `- ${path}`).join('\n')}\n\n` : '';
  const anchor =
    paths.length > 1
      ? 'the path in the "--- File:" header of the section the line came from'
      : `${paths[0] ?? 'the file under review'}`;
  return (
    `Review the following Git diff for a code change.\n\n` +
    fileList +
    'CRITICAL INSTRUCTIONS:\n' +
    '1. Only point out actionable, valid issues. If the code is good, return an empty findings list.\n' +
    `2. Every finding must set "file" to ${anchor} and "line" to a number copied verbatim from the gutter of an ` +
    'added (+) line in that same section. Lines with a "-" gutter (removed lines) and unchanged context lines cannot ' +
    'be commented on. Also set "code" to that line\'s own text, copied verbatim without the gutter and without the ' +
    'leading "+": the comment is anchored to the line whose code matches, so a "code" that does not belong to the ' +
    '"line" you named moves or discards the comment.\n' +
    '3. Explain the problem and its impact, then — when a concrete fix fits on the flagged line(s) — append a ' +
    `suggestion block:\n${fence}\n<corrected code>\n\`\`\`\n` +
    '4. Do not review generated or vendored content (lock files, build output, snapshots): return no findings for it.\n' +
    '5. Review the diff below and nothing else. Do not open the changed files to read their full contents — if the ' +
    'diff alone is not enough to be sure a finding is real, drop that finding.\n\n' +
    roundContext +
    '### Git Diff Data (gutter = line number in the new file):\n' +
    `${renderSections(chunks)}\n`
  );
}
