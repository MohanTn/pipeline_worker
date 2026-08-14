/**
 * What the human picker and the turn history agree on: how a finding is
 * identified across review rounds, and what an earlier round already did with
 * it.
 *
 * A finding has no id of its own — the agent produces a fresh list every round
 * — so identity is derived: file, anchored line, and a hash of the comment's
 * own text. Whitespace is normalized first so a re-worded-identically finding
 * from a later round still matches the one turn 1 posted.
 */

import { createHash } from 'node:crypto';
import type { ReviewFinding } from './types.js';

/**
 * A finding on its way to the forge. `body` is the human's text when the
 * picker's editor was used; the anchor (file/line/severity) is never editable,
 * since moving a comment off the line the agent verified would make it
 * unpostable — see findings.ts's anchor check.
 */
export interface SelectableFinding extends ReviewFinding {
  /** Human-edited markdown replacing `comment`, or undefined when the AI text stands. */
  body?: string;
  edited?: boolean;
}

/** One review round on one MR/PR, as persisted by state/reviewTurns.ts. */
export interface ReviewTurnRecord {
  turn: number;
  /** ISO 8601 — when the round finished. */
  at: string;
  /** Keys of the findings that reached the forge. */
  posted: string[];
  /** Keys the human unchecked (or cancelled away), so the next round can re-offer them unchecked. */
  ignored: string[];
  /** Keys whose body the human rewrote before posting. */
  edited: string[];
  /** Comment-thread ids the MR/PR carried at the end of the round — the baseline the next round diffs against to find new ones. */
  threadIds: string[];
}

/** Where a finding stands relative to the rounds already recorded. */
export type FindingStatus = 'new' | 'seen' | 'ignored';

export interface FindingCandidate {
  finding: ReviewFinding;
  key: string;
  status: FindingStatus;
  /** The round that posted or ignored it, for the row's `[posted in turn 1]` tag. */
  lastTurn?: number;
}

/**
 * Offers a round's findings to a human. Resolves with what should be posted
 * (bodies possibly rewritten), or `undefined` when the human cancelled —
 * cancelling posts nothing and remembers nothing, so the next round offers the
 * same findings unchanged. Implemented by ui/tui/reviewSession.ts; injected,
 * so workflow code never imports the TUI.
 */
export type FindingSelector = (candidates: FindingCandidate[], turn: number) => Promise<SelectableFinding[] | undefined>;

/** Stable identity for a finding across rounds: anchor plus a short hash of its normalized text. */
export function findingKey(finding: ReviewFinding): string {
  const text = finding.comment.replace(/\s+/g, ' ').trim();
  return `${finding.file}:${finding.line}:${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
}

/** The round about to run. An empty (or unreadable — see reviewTurns.ts) history means this is round 1. */
export function nextTurnNumber(turns: ReviewTurnRecord[]): number {
  return turns.reduce((highest, record) => Math.max(highest, record.turn), 0) + 1;
}

/**
 * Labels each finding with what earlier rounds did with it. Posted wins over
 * ignored: a comment that is already on the MR/PR must not be offered again
 * just because a later round's human unchecked it.
 */
export function classifyFindings(findings: ReviewFinding[], turns: ReviewTurnRecord[]): FindingCandidate[] {
  const posted = new Map<string, number>();
  const ignored = new Map<string, number>();
  for (const record of [...turns].sort((a, b) => a.turn - b.turn)) {
    for (const key of record.posted) posted.set(key, record.turn);
    for (const key of record.ignored) ignored.set(key, record.turn);
  }
  return findings.map((finding) => {
    const key = findingKey(finding);
    if (posted.has(key)) return { finding, key, status: 'seen' as const, lastTurn: posted.get(key) };
    if (ignored.has(key)) return { finding, key, status: 'ignored' as const, lastTurn: ignored.get(key) };
    return { finding, key, status: 'new' as const };
  });
}

/** Thread ids on the MR/PR that no earlier round had seen — the comments this round has to react to. */
export function unseenThreadIds(current: string[], turns: ReviewTurnRecord[]): string[] {
  const known = new Set(turns.flatMap((record) => record.threadIds));
  return current.filter((id) => !known.has(id));
}
