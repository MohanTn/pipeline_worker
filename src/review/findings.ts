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

/**
 * Applies the whole gate. `chunks` is the authority on where a comment may
 * land: an anchor outside chunk.commentableLines is a hallucinated (or
 * old-file) line number, and posting it would earn a forge 422 at best and a
 * comment on unrelated code at worst.
 */
export function gatekeep(findings: ReviewFinding[], chunks: DiffChunk[], minSeverity: ReviewSeverity, maxComments: number): ReviewFinding[] {
  const commentable = new Map<string, Set<number>>();
  for (const chunk of chunks) {
    const lines = commentable.get(chunk.path) ?? new Set<number>();
    for (const line of chunk.commentableLines) lines.add(line);
    commentable.set(chunk.path, lines);
  }

  const floor = SEVERITY_RANK[minSeverity];
  const seen = new Set<string>();
  const kept: ReviewFinding[] = [];
  for (const finding of findings) {
    const file = normalizePath(finding.file);
    const key = `${file}:${finding.line}`;
    if (SEVERITY_RANK[finding.severity] < floor) continue;
    if (!commentable.get(file)?.has(finding.line)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...finding, file });
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
