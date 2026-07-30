/**
 * Turns the agent's answer into the (small) set of comments actually worth
 * posting. Agent output is untrusted input — the same stance captureIntent.ts
 * takes — so it is zod-validated first, then gatekept:
 *
 *   severity floor → anchor must exist in the diff → dedupe → cap
 *
 * The gate is what keeps this from becoming bot spam: a reviewer who gets ten
 * MINOR nitpicks per MR stops reading the CRITICAL one.
 */

import { z } from 'zod';
import { SEVERITY_RANK, type DiffChunk, type ReviewFinding, type ReviewSeverity } from './types.js';
import type { ForgeName } from '../types.js';

const FindingShape = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  comment: z.string().min(1),
  // Optional so an agent that ignores the field is still gated on the number
  // alone, exactly as before it existed.
  code: z.string().optional(),
});

const PayloadShape = z.union([z.object({ findings: z.array(FindingShape) }), z.array(FindingShape)]);

/** Agents wrap JSON in prose or fences often enough to be worth one salvage attempt. */
function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const start = trimmed.search(/[[{]/);
  if (start === -1) return undefined;
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  return end > start ? trimmed.slice(start, end + 1) : undefined;
}

/**
 * Parses one chunk's answer. Never throws: an unusable payload contributes no
 * findings and the remaining chunks are still reviewed (reviewDiff.ts), which
 * is the difference between "one flaky turn" and "no review at all".
 */
export function parseFindings(text: string): ReviewFinding[] {
  const json = extractJson(text);
  if (!json) return [];
  try {
    const parsed = PayloadShape.parse(JSON.parse(json));
    return Array.isArray(parsed) ? parsed : parsed.findings;
  } catch {
    return [];
  }
}

/** `a/src/x.ts`, `b/src/x.ts`, and `./src/x.ts` all mean `src/x.ts` to the forge APIs. */
function normalizePath(path: string): string {
  return path.replace(/^[ab]\//, '').replace(/^\.\//, '').trim();
}

/** Compares a quoted line with a diff line ignoring indentation only — a re-indented quote is the same line, a different statement is not. */
function sameLine(quoted: string, actual: string): boolean {
  return quoted.trim() === actual.trim();
}

/**
 * Where this finding really belongs, or undefined when it belongs nowhere.
 *
 * The number alone is weak evidence: within one file every added line's number
 * is "legal", and a multi-file turn gives a model many chances to copy a number
 * out of the wrong section — a mistake the old check could not see, because the
 * number it landed on was commentable too. So when the agent also quoted the
 * line, the *code* decides: a quote matching some other added line re-anchors
 * the comment there (nearest such line, when the same code appears more than
 * once), and a quote matching nothing leaves the claimed number to be judged on
 * its own as before.
 */
function resolveAnchor(text: Record<number, string>, claimed: number, code: string | undefined): number | undefined {
  const claimedText = text[claimed];
  if (code === undefined) return claimedText === undefined ? undefined : claimed;
  if (claimedText !== undefined && sameLine(code, claimedText)) return claimed;

  const matches = Object.keys(text)
    .map(Number)
    .filter((line) => sameLine(code, text[line]));
  if (matches.length > 0) return matches.reduce((best, line) => (Math.abs(line - claimed) < Math.abs(best - claimed) ? line : best));
  return claimedText === undefined ? undefined : claimed;
}

/**
 * Applies the whole gate. `chunks` is the authority on where a comment may
 * land: an anchor outside chunk.commentableLines is a hallucinated (or
 * old-file) line number, and posting it would earn a forge 422 at best and a
 * comment on unrelated code at worst.
 */
export function gatekeep(findings: ReviewFinding[], chunks: DiffChunk[], minSeverity: ReviewSeverity, maxComments: number): ReviewFinding[] {
  const commentable = new Map<string, Record<number, string>>();
  for (const chunk of chunks) {
    const text = commentable.get(chunk.path) ?? {};
    for (const line of chunk.commentableLines) text[line] = chunk.commentableText?.[line] ?? '';
    commentable.set(chunk.path, text);
  }

  const floor = SEVERITY_RANK[minSeverity];
  const seen = new Set<string>();
  const kept: ReviewFinding[] = [];
  for (const finding of findings) {
    const file = normalizePath(finding.file);
    const text = commentable.get(file);
    if (SEVERITY_RANK[finding.severity] < floor) continue;
    if (!text) continue;
    const line = resolveAnchor(text, finding.line, finding.code);
    if (line === undefined) continue;
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...finding, file, line });
  }

  return kept.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]).slice(0, Math.max(0, maxComments));
}

const SUGGESTION_FENCE = /^```suggestion(?::[-+\d]*)?[ \t]*$/gm;

/**
 * Rewrites a suggestion fence to the active forge's dialect: GitHub renders
 * ```` ```suggestion ````, GitLab needs ```` ```suggestion:-0+0 ````. The
 * prompt already asks for the right one; this is the safety net for when the
 * agent answers with the form it saw most during training.
 */
export function normalizeSuggestionFence(comment: string, forge: ForgeName): string {
  return comment.replace(SUGGESTION_FENCE, forge === 'gitlab' ? '```suggestion:-0+0' : '```suggestion');
}
