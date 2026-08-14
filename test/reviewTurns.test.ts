import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReviewTurn, loadReviewTurns } from '../src/state/reviewTurns.js';
import { listRunStates } from '../src/state/runState.js';
import type { ReviewTurnRecord } from '../src/review/selection.js';

function record(turn: number): ReviewTurnRecord {
  return { turn, at: `2026-01-0${turn}T00:00:00.000Z`, posted: [`app.ts:${turn}:aaaaaaaa`], ignored: [], edited: [], threadIds: [`t${turn}`] };
}

function withRepo(fn: (repoRoot: string) => void): void {
  const repoRoot = mkdtempSync(join(tmpdir(), 'pipeline-worker-review-turns-'));
  try {
    fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('rounds are appended in order and read back, with a branch name that has slashes', () => {
  withRepo((repoRoot) => {
    assert.deepEqual(loadReviewTurns(repoRoot, 'feat/login'), [], 'a branch never reviewed has no history');
    appendReviewTurn(repoRoot, 'feat/login', record(1));
    appendReviewTurn(repoRoot, 'feat/login', record(2));
    assert.deepEqual(loadReviewTurns(repoRoot, 'feat/login').map((entry) => entry.turn), [1, 2]);
    assert.deepEqual(loadReviewTurns(repoRoot, 'other'), [], 'history is per branch');
  });
});

test('a corrupt history file reads as no history instead of throwing', () => {
  withRepo((repoRoot) => {
    const dir = join(repoRoot, '.pipeline-worker', 'state', 'review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'main.json'), '{ not json', 'utf-8');
    assert.deepEqual(loadReviewTurns(repoRoot, 'main'), []);
  });
});

test('review history is invisible to the sessions listing — it is not a run', () => {
  withRepo((repoRoot) => {
    appendReviewTurn(repoRoot, 'feat/login', record(1));
    assert.deepEqual(listRunStates(repoRoot), []);
  });
});

test('history is capped, keeping the most recent rounds', () => {
  withRepo((repoRoot) => {
    for (let turn = 1; turn <= 25; turn++) appendReviewTurn(repoRoot, 'main', record(turn));
    const turns = loadReviewTurns(repoRoot, 'main');
    assert.equal(turns.length, 20);
    assert.equal(turns[0].turn, 6);
    assert.equal(turns.at(-1)?.turn, 25);
  });
});
