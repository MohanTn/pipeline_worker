import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFilesSinceRef, captureDiff } from '../src/git/diff.js';

const execFileAsync = promisify(execFile);

test('changedFilesSinceRef lists files changed since a fixed ref, not since HEAD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-diffsinceref-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    const { stdout: baseSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });

    writeFileSync(join(dir, 'b.txt'), 'b\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'add b'], { cwd: dir });

    writeFileSync(join(dir, 'c.txt'), 'c\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'add c'], { cwd: dir });

    // Since the base commit, both b.txt and c.txt were added across two
    // commits — a plain `git diff HEAD` (uncommitted-only) would see none of
    // this, which is exactly why the adopt path needs a ref-based diff.
    assert.deepEqual(await changedFilesSinceRef(dir, baseSha.trim()), ['b.txt', 'c.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFilesSinceRef returns an empty array when there is nothing new since the ref', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-diffsinceref-empty-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });

    assert.deepEqual(await changedFilesSinceRef(dir, 'HEAD'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('captureDiff counts modified and deleted tracked files separately from untracked new files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-capturediff-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
    writeFileSync(join(dir, 'edit.txt'), 'original\n');
    writeFileSync(join(dir, 'remove.txt'), 'gone\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });

    writeFileSync(join(dir, 'edit.txt'), 'changed\n');
    rmSync(join(dir, 'remove.txt'));
    writeFileSync(join(dir, 'new.txt'), 'untracked\n');

    const result = await captureDiff(dir);
    assert.equal(result.modifiedCount, 1);
    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.untrackedFiles, ['new.txt']);
    assert.deepEqual(result.changedFiles.sort(), ['edit.txt', 'remove.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
