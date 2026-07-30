/**
 * Which recovery `pipeline-worker resume` picks: continuing the failed run's
 * own worktree from the stage it died in, or falling through to the
 * origin-based resume/adopt paths. Real git worktrees, since the whole
 * decision hinges on whether one is still usable on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findContinuableRun } from '../src/workflow/runCommands.js';
import { createWorktree, removeWorktree } from '../src/git/worktree.js';
import { saveRunState } from '../src/state/runState.js';
import type { RunState } from '../src/types.js';

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-resume-dispatch-'));
  writeFileSync(join(dir, 'file.txt'), 'hello\n');
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function state(overrides: Partial<RunState>): RunState {
  return { branch: 'feature/x', targetBranch: 'main', worktreePath: '/tmp/gone', ciFixAttempt: 0, conflictAttempt: 0, phase: 'checks', ...overrides };
}

test('a run that died before its MR/PR, with its worktree still on disk, is continued from that worktree', async () => {
  const repoRoot = await makeRepo();
  try {
    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-continue');
    try {
      saveRunState(repoRoot, state({ worktreePath, phase: 'intent', failedStage: 'commit' }));
      const found = await findContinuableRun(repoRoot, 'feature/x');
      assert.equal(found?.worktreePath, worktreePath);
      assert.equal(found?.failedStage, 'commit');
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('a run whose worktree is gone falls through to the origin-based resume/adopt paths', async () => {
  const repoRoot = await makeRepo();
  try {
    saveRunState(repoRoot, state({ worktreePath: join(repoRoot, 'never-existed') }));
    assert.equal(await findContinuableRun(repoRoot, 'feature/x'), undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('a run that already opened an MR/PR is left to the watch-only resume path, not re-run through the stages', async () => {
  const repoRoot = await makeRepo();
  try {
    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-has-mr');
    try {
      saveRunState(repoRoot, state({ worktreePath, phase: 'mr', mrIid: 7 }));
      assert.equal(await findContinuableRun(repoRoot, 'feature/x'), undefined);
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('a branch with no run state at all is not continuable', async () => {
  const repoRoot = await makeRepo();
  try {
    assert.equal(await findContinuableRun(repoRoot, 'feature/never-run'), undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
