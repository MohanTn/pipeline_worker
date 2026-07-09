import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRunState, loadRunState, recordEvent, recordAgentTokens, listRunStates } from '../src/state/runState.js';
import type { RunState } from '../src/types.js';

function baseState(overrides: Partial<RunState> = {}): RunState {
  return { branch: 'feature/x', targetBranch: 'main', worktreePath: '/tmp/wt', ciFixAttempt: 0, conflictAttempt: 0, phase: 'diff', ...overrides };
}

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pipeline-worker-runstate-'));
}

test('saveRunState/loadRunState round-trip, leaving no leftover temp file behind', () => {
  const dir = tmpRepo();
  try {
    const state = baseState();
    saveRunState(dir, state);
    assert.deepEqual(loadRunState(dir, state.branch), state);

    const files = readdirSync(join(dir, '.pipeline-worker', 'state'));
    assert.deepEqual(files, ['feature_x.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRunState migrates a legacy state file that only has `attempt` into both new counters', () => {
  const dir = tmpRepo();
  try {
    saveRunState(dir, baseState({ branch: 'feature/legacy' }));
    const path = join(dir, '.pipeline-worker', 'state', 'feature_legacy.json');
    writeFileSync(
      path,
      JSON.stringify({ branch: 'feature/legacy', targetBranch: 'main', worktreePath: '/tmp/wt', attempt: 3, phase: 'watch' }),
    );
    const state = loadRunState(dir, 'feature/legacy');
    assert.equal(state?.ciFixAttempt, 3);
    assert.equal(state?.conflictAttempt, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRunState leaves ciFixAttempt/conflictAttempt untouched when already present', () => {
  const dir = tmpRepo();
  try {
    const state = baseState({ ciFixAttempt: 2, conflictAttempt: 1 });
    saveRunState(dir, state);
    const loaded = loadRunState(dir, state.branch);
    assert.equal(loaded?.ciFixAttempt, 2);
    assert.equal(loaded?.conflictAttempt, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRunState returns undefined (never throws) for a corrupt state file', () => {
  const dir = tmpRepo();
  try {
    const state = baseState();
    saveRunState(dir, state);
    writeFileSync(join(dir, '.pipeline-worker', 'state', 'feature_x.json'), '{not valid json');
    assert.equal(loadRunState(dir, state.branch), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordEvent appends a timestamped entry, sets startedAt/updatedAt, and persists it', () => {
  const dir = tmpRepo();
  try {
    const state = baseState();
    recordEvent(dir, state, 'created worktree');

    assert.equal(state.history?.length, 1);
    assert.equal(state.history?.[0].message, 'created worktree');
    assert.equal(state.history?.[0].level, 'info');
    assert.equal(state.history?.[0].phase, 'diff');
    assert.ok(state.startedAt);
    assert.equal(state.startedAt, state.updatedAt);

    assert.deepEqual(loadRunState(dir, state.branch)?.history, state.history);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordEvent caps history at 200 entries, dropping the oldest first', () => {
  const dir = tmpRepo();
  try {
    const state = baseState();
    for (let i = 0; i < 205; i++) recordEvent(dir, state, `event ${i}`, i === 204 ? 'error' : 'info');

    assert.equal(state.history?.length, 200);
    assert.equal(state.history?.[0].message, 'event 5');
    assert.equal(state.history?.[199].message, 'event 204');
    assert.equal(state.history?.[199].level, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listRunStates returns every persisted session, most recently updated first', () => {
  const dir = tmpRepo();
  try {
    const older = baseState({ branch: 'feature/older' });
    recordEvent(dir, older, 'first');
    const newer = baseState({ branch: 'feature/newer' });
    recordEvent(dir, newer, 'first');
    // Force an unambiguous ordering rather than relying on real clock ticks between the two recordEvent calls.
    newer.updatedAt = '2999-01-01T00:00:00.000Z';
    saveRunState(dir, newer);

    assert.deepEqual(
      listRunStates(dir).map((s) => s.branch),
      ['feature/newer', 'feature/older'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listRunStates returns an empty array when no run has ever been saved', () => {
  const dir = tmpRepo();
  try {
    assert.deepEqual(listRunStates(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listRunStates skips a corrupt state file rather than failing the whole listing', () => {
  const dir = tmpRepo();
  try {
    saveRunState(dir, baseState({ branch: 'feature/good' }));
    writeFileSync(join(dir, '.pipeline-worker', 'state', 'corrupt.json'), '{not valid json');

    assert.deepEqual(
      listRunStates(dir).map((s) => s.branch),
      ['feature/good'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordEvent with tokens stamps the entry and accumulates state.totalTokens across turns', () => {
  const dir = tmpRepo();
  try {
    const state = baseState();
    recordEvent(dir, state, 'Captured intent', 'info', 1900);
    recordEvent(dir, state, 'No tokens on this one');
    recordEvent(dir, state, 'Agent turn (fix CI failure)', 'info', 4400);

    assert.equal(state.totalTokens, 6300);
    const loaded = loadRunState(dir, state.branch);
    assert.equal(loaded?.totalTokens, 6300);
    assert.equal(loaded?.history?.[0].tokens, 1900);
    assert.equal(loaded?.history?.[1].tokens, undefined);
    assert.equal(loaded?.history?.[2].tokens, 4400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordAgentTokens records only when the adapter reported usage — silence for pi/copilot, never a zero', () => {
  const dir = tmpRepo();
  try {
    const state = baseState();
    recordAgentTokens(dir, state, 'resolve merge conflicts', { totalTokens: 1234 });
    recordAgentTokens(dir, state, 'resolve merge conflicts', undefined);
    recordAgentTokens(dir, state, 'resolve merge conflicts', { costUsd: 0.5 });

    assert.equal(state.totalTokens, 1234);
    assert.equal(state.history?.length, 1);
    assert.match(state.history![0].message, /Agent turn \(resolve merge conflicts\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a state file written before token accounting loads with totalTokens simply absent', () => {
  const dir = tmpRepo();
  try {
    saveRunState(dir, baseState({ branch: 'feature/old' }));
    const loaded = loadRunState(dir, 'feature/old');
    assert.equal(loaded?.totalTokens, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
