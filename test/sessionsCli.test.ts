/**
 * Drives the compiled CLI's `sessions` subcommand as a subprocess against a
 * scratch repo directory — exercises listRunStates/recordEvent/ui/sessions.ts
 * wiring end to end (mirrors test/cli.test.ts's subprocess convention).
 *
 * NOTE: requires `npm run build` to have run first (exercises dist/cli.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEvent } from '../src/state/runState.js';
import type { RunState } from '../src/types.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pipeline-worker-sessions-cli-'));
}

test('pipeline-worker sessions reports none in a repo with no runs', () => {
  const dir = tmpRepo();
  try {
    const output = execFileSync('node', [cliPath, 'sessions'], { cwd: dir, encoding: 'utf-8' });
    assert.match(output, /no sessions found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline-worker sessions --branch <missing> exits non-zero', () => {
  const dir = tmpRepo();
  try {
    assert.throws(() => execFileSync('node', [cliPath, 'sessions', '--branch', 'does-not-exist'], { cwd: dir, encoding: 'utf-8' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline-worker sessions lists a persisted run, and --branch shows its timeline', () => {
  const dir = tmpRepo();
  try {
    const state: RunState = { branch: 'feature/add-login', targetBranch: 'main', worktreePath: '/tmp/wt', attempt: 1, phase: 'watch' };
    recordEvent(dir, state, 'Created worktree');
    recordEvent(dir, state, 'Pipeline failed; attempt 1/3', 'error');

    const list = execFileSync('node', [cliPath, 'sessions'], { cwd: dir, encoding: 'utf-8' });
    assert.match(list, /feature\/add-login/);
    assert.match(list, /watch/);

    const detail = execFileSync('node', [cliPath, 'sessions', '--branch', 'feature/add-login'], { cwd: dir, encoding: 'utf-8' });
    assert.match(detail, /Session: feature\/add-login/);
    assert.match(detail, /Created worktree/);
    assert.match(detail, /Pipeline failed; attempt 1\/3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
