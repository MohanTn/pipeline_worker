import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiff } from '../src/git/diff.js';
import { createWorktree, syncWithOrigin, applyDiffToWorktree, removeWorktree } from '../src/git/worktree.js';

const execFileAsync = promisify(execFile);
const FIXTURE = join(import.meta.dirname, 'fixtures', 'sample-repo');

async function makeSampleRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-repo-'));
  cpSync(FIXTURE, dir, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('createWorktree + applyDiffToWorktree carries a tracked-file change and an untracked file', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    writeFileSync(join(repoRoot, 'package.json'), readFileSync(join(repoRoot, 'package.json'), 'utf-8').replace('1.0.0', '1.0.1'));
    writeFileSync(join(repoRoot, 'new-file.txt'), 'hello from pipeline-worker\n');

    const { diffText, untrackedFiles } = await captureDiff(repoRoot);
    assert.match(diffText, /1\.0\.1/);
    assert.deepEqual(untrackedFiles, ['new-file.txt']);

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-test');
    try {
      await applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot);

      const worktreePkg = readFileSync(join(worktreePath, 'package.json'), 'utf-8');
      assert.match(worktreePkg, /1\.0\.1/);
      assert.equal(readFileSync(join(worktreePath, 'new-file.txt'), 'utf-8'), 'hello from pipeline-worker\n');
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }

    assert.equal(existsSync(worktreePath), false);
    const { stdout: worktreeList } = await execFileAsync('git', ['worktree', 'list'], { cwd: repoRoot });
    assert.doesNotMatch(worktreeList, /tmp-test/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('applyDiffToWorktree falls back to a 3-way merge with conflict markers when the base has moved, instead of failing outright', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    // Capture a diff against the current HEAD's package.json (version "1.0.0" -> "1.0.1").
    writeFileSync(join(repoRoot, 'package.json'), readFileSync(join(repoRoot, 'package.json'), 'utf-8').replace('1.0.0', '1.0.1'));
    const { diffText, untrackedFiles } = await captureDiff(repoRoot);
    assert.match(diffText, /1\.0\.1/);

    // Discard that uncommitted change, then move repoRoot's HEAD forward with
    // a *different* edit to the same line — simulating origin having moved
    // past the diff's base (exactly what syncWithOrigin's rebase does).
    await execFileAsync('git', ['checkout', '--', 'package.json'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'package.json'), readFileSync(join(repoRoot, 'package.json'), 'utf-8').replace('1.0.0', '2.0.0'));
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'bump to 2.0.0'], { cwd: repoRoot });

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-conflict-test');
    try {
      const result = await applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot);

      assert.equal(result.conflicted, true);
      assert.deepEqual(result.conflictedFiles, ['package.json']);
      assert.match(readFileSync(join(worktreePath, 'package.json'), 'utf-8'), /<{7}/);
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncWithOrigin rebases the worktree onto a moved-ahead origin/main, preserving a local-only commit', async () => {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-origin-'));
  const repoRoot = await makeSampleRepo();
  const otherClone = mkdtempSync(join(tmpdir(), 'pipeline-worker-other-'));
  try {
    await execFileAsync('git', ['init', '-q', '--bare', originDir]);
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoRoot });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repoRoot });

    // Someone else pushes a new commit to origin/main that repoRoot hasn't fetched yet.
    // The bare origin has no HEAD ref pointing at a branch, so clone can't
    // check one out automatically — check out main explicitly, or this
    // would silently commit to a disconnected local "master" instead.
    await execFileAsync('git', ['clone', '-q', originDir, otherClone]);
    await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
    writeFileSync(join(otherClone, 'upstream-change.txt'), 'from origin\n');
    await execFileAsync('git', ['add', '-A'], { cwd: otherClone });
    await execFileAsync('git', ['commit', '-q', '-m', 'upstream change'], { cwd: otherClone });
    await execFileAsync('git', ['push', '-q'], { cwd: otherClone });

    // repoRoot gets its own local-only commit, still unaware of the upstream change above.
    writeFileSync(join(repoRoot, 'local-only.txt'), 'local work\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'local only commit'], { cwd: repoRoot });

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-sync-test');
    try {
      await syncWithOrigin(worktreePath, 'main');

      // Both the upstream commit and the local-only commit must survive a
      // rebase (a `reset --hard` to origin would have silently dropped the
      // local-only commit instead of replaying it on top).
      assert.equal(existsSync(join(worktreePath, 'upstream-change.txt')), true);
      assert.equal(existsSync(join(worktreePath, 'local-only.txt')), true);

      const { stdout: log } = await execFileAsync('git', ['log', '--oneline', '--reverse'], { cwd: worktreePath });
      const lines = log.trim().split('\n');
      assert.equal(lines.length, 3);
      assert.match(lines[1], /upstream change/);
      assert.match(lines[2], /local only commit/);
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(otherClone, { recursive: true, force: true });
  }
});
