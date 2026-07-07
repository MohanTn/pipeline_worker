import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { squashCommitsSinceMergeBase } from '../src/git/squash.js';
import { forcePushWithLease } from '../src/git/commit.js';

const execFileAsync = promisify(execFile);

/** A repo with `origin/main` and a feature branch that has 3 commits past the merge-base, all pushed. */
async function makeBranchWithCommits(): Promise<{ worktreePath: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-squash-origin-'));
  const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-squash-repo-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: worktreePath });
  writeFileSync(join(worktreePath, 'file.txt'), 'base\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: worktreePath });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: worktreePath });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: worktreePath });

  await execFileAsync('git', ['checkout', '-q', '-b', 'feature/squash-me'], { cwd: worktreePath });
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(worktreePath, 'file.txt'), `base\nchange ${i}\n`);
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
    await execFileAsync('git', ['commit', '-q', '-m', `fix: address CI failure (attempt ${i})`], { cwd: worktreePath });
  }
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'feature/squash-me'], { cwd: worktreePath });

  return { worktreePath, originDir };
}

async function commitCount(dir: string, ref = 'HEAD'): Promise<number> {
  const { stdout } = await execFileAsync('git', ['rev-list', '--count', ref], { cwd: dir });
  return Number(stdout.trim());
}

test('squashCommitsSinceMergeBase collapses multiple commits into one, preserving tree content', async () => {
  const { worktreePath, originDir } = await makeBranchWithCommits();
  try {
    assert.equal(await commitCount(worktreePath), 4); // init + 3 fix commits

    await squashCommitsSinceMergeBase(worktreePath, 'main', 'fix: address the underlying bug');

    assert.equal(await commitCount(worktreePath), 2); // init + 1 squashed commit
    const { stdout: log } = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: worktreePath });
    assert.equal(log.trim(), 'fix: address the underlying bug');
    assert.equal(readFileSync(join(worktreePath, 'file.txt'), 'utf-8'), 'base\nchange 3\n'); // tree content unchanged
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('squashCommitsSinceMergeBase throws when there is nothing to squash (HEAD already at the merge-base)', async () => {
  const { worktreePath, originDir } = await makeBranchWithCommits();
  try {
    await execFileAsync('git', ['fetch', 'origin', 'main'], { cwd: worktreePath });
    await execFileAsync('git', ['checkout', '-q', '-B', 'feature/no-op', 'origin/main'], { cwd: worktreePath });

    await assert.rejects(() => squashCommitsSinceMergeBase(worktreePath, 'main', 'fix: nothing'), /nothing to squash/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('forcePushWithLease succeeds when the local ref matches what origin last had', async () => {
  const { worktreePath, originDir } = await makeBranchWithCommits();
  try {
    await squashCommitsSinceMergeBase(worktreePath, 'main', 'fix: squashed');
    await forcePushWithLease(worktreePath, 'origin', 'feature/squash-me');
    assert.equal(await commitCount(originDir, 'feature/squash-me'), 2);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('forcePushWithLease rejects when origin has moved since it was last observed (protects against clobbering)', async () => {
  const { worktreePath, originDir } = await makeBranchWithCommits();
  const otherClone = mkdtempSync(join(tmpdir(), 'pipeline-worker-squash-other-'));
  try {
    // A second clone pushes an extra commit to the same branch first, without worktreePath's knowledge.
    await execFileAsync('git', ['clone', '-q', originDir, otherClone]);
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: otherClone });
    await execFileAsync('git', ['checkout', '-q', 'feature/squash-me'], { cwd: otherClone });
    writeFileSync(join(otherClone, 'other.txt'), 'someone else pushed this\n');
    await execFileAsync('git', ['add', '-A'], { cwd: otherClone });
    await execFileAsync('git', ['commit', '-q', '-m', 'a commit worktreePath does not know about'], { cwd: otherClone });
    await execFileAsync('git', ['push', '-q', 'origin', 'feature/squash-me'], { cwd: otherClone });

    await squashCommitsSinceMergeBase(worktreePath, 'main', 'fix: squashed');
    await assert.rejects(() => forcePushWithLease(worktreePath, 'origin', 'feature/squash-me'));
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(otherClone, { recursive: true, force: true });
  }
});
