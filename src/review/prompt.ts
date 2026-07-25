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
          severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'], description: 'CRITICAL: data loss, security hole, or guaranteed crash. MAJOR: a real bug or serious performance/design defect. MINOR: everything else.' },
          comment: { type: 'string', description: 'Markdown: a "### Title" line, the explanation and its impact, then an optional suggestion block with the corrected line(s).' },
        },
        required: ['file', 'line', 'severity', 'comment'],
      },
    },
  },
  required: ['findings'],
} as const;

/**
 * One prompt per chunk. The diff is rendered with its new-file line numbers
 * in a left gutter (see chunkDiff.ts) and the agent is told to copy one of
 * those numbers verbatim — anything it invents anyway is dropped by
 * findings.ts before it reaches the forge.
 *
 * The reviewer's persona lives in REVIEW_SYSTEM, delivered as the turn's
 * system prompt rather than prefixed here, so what follows is only this
 * chunk's own instructions and data.
 */
export function buildReviewPrompt(chunk: DiffChunk, fence: string): string {
  return (
    `Review the following Git diff for a code change.\n\n` +
    `File: ${chunk.path}\nLanguage: ${chunk.language}\n\n` +
    'CRITICAL INSTRUCTIONS:\n' +
    '1. Only point out actionable, valid issues. If the code is good, return an empty findings list.\n' +
    `2. Every finding must set "file" to ${chunk.path} and "line" to a number copied verbatim from the gutter of an ` +
    'added (+) line below. Lines with a "-" gutter (removed lines) and unchanged context lines cannot be commented on.\n' +
    '3. Explain the problem and its impact, then — when a concrete fix fits on the flagged line(s) — append a ' +
    `suggestion block:\n${fence}\n<corrected code>\n\`\`\`\n` +
    '4. Do not review generated or vendored content (lock files, build output, snapshots): return no findings for it.\n' +
    '5. Review the diff below and nothing else. Do not open the changed file to read its full contents — if the ' +
    'diff alone is not enough to be sure a finding is real, drop that finding.\n\n' +
    '### Git Diff Data (gutter = line number in the new file):\n' +
    `${chunk.body}\n`
  );
}
