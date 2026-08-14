/**
 * Per-branch review-round history, at
 * <repoRoot>/.pipeline-worker/state/review/<branch>.json.
 *
 * Deliberately not a field on RunState: `review --branch` is routinely pointed
 * at a branch this machine never ran (a colleague's MR), which has no run state
 * and must not be given a fabricated one — a synthetic state file would show up
 * in `sessions` and offer `resume` a run that never existed. The `review/`
 * subdirectory is invisible to listRunStates, which only reads `*.json` entries
 * directly under state/.
 *
 * Read/write never throw, matching runState.ts: a lost history only means the
 * next review reads as round 1 and may re-offer a comment already posted.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ReviewTurnRecord } from '../review/selection.js';

/** Rounds kept per branch — enough to remember what a long-lived MR was told, bounded so the file cannot grow forever. */
const MAX_TURNS = 20;

interface ReviewTurnFile {
  branch: string;
  turns: ReviewTurnRecord[];
}

function reviewDir(repoRoot: string): string {
  return join(repoRoot, '.pipeline-worker', 'state', 'review');
}

function reviewPath(repoRoot: string, branch: string): string {
  return join(reviewDir(repoRoot), `${branch.replace(/\//g, '_')}.json`);
}

export function loadReviewTurns(repoRoot: string, branch: string): ReviewTurnRecord[] {
  const path = reviewPath(repoRoot, branch);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ReviewTurnFile;
    return Array.isArray(parsed.turns) ? parsed.turns : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to read review history at ${path}: ${message}`);
    return [];
  }
}

/** Appends one round, keeping the newest MAX_TURNS. Same temp-file-then-rename write as runState.ts, so a kill mid-write cannot truncate the file. */
export function appendReviewTurn(repoRoot: string, branch: string, record: ReviewTurnRecord): void {
  try {
    const dir = reviewDir(repoRoot);
    mkdirSync(dir, { recursive: true });
    const turns = [...loadReviewTurns(repoRoot, branch), record];
    const file: ReviewTurnFile = { branch, turns: turns.slice(Math.max(0, turns.length - MAX_TURNS)) };
    const tmpPath = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
    renameSync(tmpPath, reviewPath(repoRoot, branch));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to persist review history for branch ${branch}: ${message}`);
  }
}
