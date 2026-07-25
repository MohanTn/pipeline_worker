/**
 * The end-of-run branch swap: after a green run, repoRoot is left standing on
 * the feature branch, so the next edit + `pipeline-worker run` becomes a
 * follow-up commit on the same MR/PR instead of a second one. Exercised
 * against real throwaway repos, per CLAUDE.md's git-testing convention.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeSwitchToFeatureBranch } from '../src/workflow/orchestrate.js';
import { currentBranch } from '../src/git/commit.js';
import type { PipelineWorkerConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);

const FEATURE_BRANCH = 'pipeline-worker/add-login';

function testConfig(switchToFeatureBranch: boolean): PipelineWorkerConfig {
  return { switchToFeatureBranch } as PipelineWorkerConfig;
}

/** A repo on its default branch with one commit, plus an already-created (not checked out) feature branch. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-switch-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  await execFileAsync('git', ['branch', FEATURE_BRANCH], { cwd: dir });
  return dir;
}

/** Silences the run-tree narration these steps emit, so the suite's output stays readable. */
async function quietly(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
}

async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeRepo();
  try {
    await quietly(() => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the run leaves the repo on the feature branch, removing the worktree first', async () => {
  await withRepo(async (dir) => {
    let cleanups = 0;
    await maybeSwitchToFeatureBranch(testConfig(true), dir, FEATURE_BRANCH, async () => {
      cleanups += 1;
    });

    assert.equal(await currentBranch(dir), FEATURE_BRANCH);
    // git refuses one branch in two worktrees, so the run's worktree has to
    // be gone before the checkout — not merely afterwards, in the outer finally.
    assert.equal(cleanups, 1);
  });
});

test('switchToFeatureBranch disabled leaves the repo (and the worktree) exactly as the run found it', async () => {
  await withRepo(async (dir) => {
    let cleanups = 0;
    await maybeSwitchToFeatureBranch(testConfig(false), dir, FEATURE_BRANCH, async () => {
      cleanups += 1;
    });

    assert.equal(await currentBranch(dir), 'main');
    assert.equal(cleanups, 0);
  });
});

test('a repo with uncommitted changes is left alone — the switch never drags them onto the feature branch', async () => {
  await withRepo(async (dir) => {
    // What cleanupOnSuccess=false leaves behind: the run's original edits are
    // still sitting in the working tree.
    writeFileSync(join(dir, 'f.txt'), 'edited after the run\n');

    let cleanups = 0;
    await maybeSwitchToFeatureBranch(testConfig(true), dir, FEATURE_BRANCH, async () => {
      cleanups += 1;
    });

    assert.equal(await currentBranch(dir), 'main');
    assert.equal(cleanups, 0);
  });
});

test('an untracked file also blocks the switch, since checkout would carry it across', async () => {
  await withRepo(async (dir) => {
    writeFileSync(join(dir, 'scratch.txt'), 'not committed\n');

    await maybeSwitchToFeatureBranch(testConfig(true), dir, FEATURE_BRANCH, async () => {});

    assert.equal(await currentBranch(dir), 'main');
  });
});

test('a checkout failure is a note, not a thrown error — the run has already succeeded by this point', async () => {
  await withRepo(async (dir) => {
    await maybeSwitchToFeatureBranch(testConfig(true), dir, 'branch/that/never-existed', async () => {});

    assert.equal(await currentBranch(dir), 'main');
  });
});

test('a repo that is already on the branch (a follow-up run) stays there', async () => {
  await withRepo(async (dir) => {
    await execFileAsync('git', ['checkout', '-q', FEATURE_BRANCH], { cwd: dir });

    await maybeSwitchToFeatureBranch(testConfig(true), dir, FEATURE_BRANCH, async () => {});

    assert.equal(await currentBranch(dir), FEATURE_BRANCH);
  });
});
