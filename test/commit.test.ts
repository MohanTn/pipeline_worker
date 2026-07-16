import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGitUser, listConflictedFiles, findUnresolvedConflictMarkers, mergeBase, findRepoRoot } from '../src/git/commit.js';

const execFileAsync = promisify(execFile);

/** Produces a repo with f.txt left mid-conflict (git index unmerged, markers in the working tree). */
async function makeConflictedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-conflict-'));
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
  writeFileSync(join(dir, 'f.txt'), 'line1\nline2\nline3\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  writeFileSync(join(dir, 'f.txt'), 'line1\nline2-ours\nline3\n');
  const { stdout: patch } = await execFileAsync('git', ['diff', 'HEAD', '--full-index'], { cwd: dir });
  await execFileAsync('git', ['checkout', '--', 'f.txt'], { cwd: dir });

  writeFileSync(join(dir, 'f.txt'), 'line1\nline2-theirs\nline3\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'theirs'], { cwd: dir });

  const patchFile = join(dir, 'ours.patch');
  writeFileSync(patchFile, patch);
  await execFileAsync('git', ['apply', '--3way', '--index', patchFile], { cwd: dir }).catch(() => {});
  return dir;
}

test('getGitUser reads user.name/user.email from the repo config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-gitconfig-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });

    const user = await getGitUser(dir);
    assert.deepEqual(user, { name: 'Test User', email: 'test@example.com' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRepoRoot returns the repo root when called from the repo root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-reporoot-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    const root = await findRepoRoot(dir);
    assert.equal(root, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRepoRoot returns the repo root when called from a subdirectory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-subdir-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    const subdir = join(dir, 'subdir', 'nested');
    await execFileAsync('mkdir', ['-p', subdir]);
    const root = await findRepoRoot(subdir);
    assert.equal(root, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findUnresolvedConflictMarkers reports the file while markers remain, unlike listConflictedFiles which reflects the git index', async () => {
  const dir = await makeConflictedRepo();
  try {
    assert.deepEqual(await listConflictedFiles(dir), ['f.txt']);
    assert.deepEqual(findUnresolvedConflictMarkers(dir, ['f.txt']), ['f.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findUnresolvedConflictMarkers reports the file as resolved once markers are edited out, even before `git add`', async () => {
  const dir = await makeConflictedRepo();
  try {
    // Simulate an editor (human or agent) fixing the content directly,
    // without staging — this is exactly what left the real run reporting
    // "still conflicted" even though the agent had already fixed the file:
    // git's index keeps a file flagged unmerged until `git add` re-stages
    // it, regardless of whether the content still has markers.
    writeFileSync(join(dir, 'f.txt'), 'line1\nline2-resolved\nline3\n');

    assert.deepEqual(await listConflictedFiles(dir), ['f.txt']); // index is stale — still shows unmerged
    assert.deepEqual(findUnresolvedConflictMarkers(dir, ['f.txt']), []); // content is actually clean
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeBase returns the commit where HEAD diverged from the given ref, not either tip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-mergebase-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
    writeFileSync(join(dir, 'f.txt'), 'base\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    const { stdout: baseSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });

    await execFileAsync('git', ['checkout', '-q', '-b', 'main-ahead'], { cwd: dir });
    writeFileSync(join(dir, 'main-only.txt'), 'main moved on\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'main moved on'], { cwd: dir });

    await execFileAsync('git', ['checkout', '-q', '-b', 'feature', baseSha.trim()], { cwd: dir });
    writeFileSync(join(dir, 'feature-only.txt'), 'feature work\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'feature work'], { cwd: dir });

    assert.equal(await mergeBase(dir, 'main-ahead'), baseSha.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getGitUser returns empty strings instead of throwing when config is unset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-gitconfig-'));
  // getGitUser's child process inherits process.env, so isolate from this
  // machine's real global git config (~/.gitconfig) by pointing HOME at the
  // empty temp dir for the duration of this test — otherwise this test would
  // pass or fail depending on whoever's machine it runs on.
  const origHome = process.env.HOME;
  const origNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.HOME = dir;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    const user = await getGitUser(dir);
    assert.deepEqual(user, { name: '', email: '' });
  } finally {
    process.env.HOME = origHome;
    process.env.GIT_CONFIG_NOSYSTEM = origNoSystem;
    rmSync(dir, { recursive: true, force: true });
  }
});
