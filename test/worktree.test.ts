import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiff } from '../src/git/diff.js';
import { createWorktree, applyDiffToWorktree, removeWorktree } from '../src/git/worktree.js';

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
