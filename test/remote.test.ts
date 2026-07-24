import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGithubRepo, detectDefaultBranch, remoteBranchExists } from '../src/git/remote.js';

const execFileAsync = promisify(execFile);

async function makeRepo(remoteUrl?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-remote-'));
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  if (remoteUrl) await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
  return dir;
}

/**
 * A repo wired to a bare origin holding `branches` (the first is checked out
 * locally), with no `refs/remotes/origin/HEAD` anywhere — the shape that
 * forces detectDefaultBranch past both symref tiers onto the main/master probe.
 */
async function makeRepoWithRemoteBranches(branches: string[]): Promise<{ repoDir: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-remote-'));
  await execFileAsync('git', ['init', '-q', '--bare'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', branches[0]], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoDir });
  for (const branch of branches) {
    await execFileAsync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: repoDir });
  }
  await execFileAsync('git', ['fetch', '-q', 'origin'], { cwd: repoDir });
  await blindOriginHead(repoDir, originDir);
  return { repoDir, originDir };
}

/**
 * Removes every trace of a default-branch symref — origin's own HEAD (pointed
 * at a branch that doesn't exist, as a repo whose trunk was renamed ends up)
 * and the local `refs/remotes/origin/HEAD` a modern `git fetch` sets. What's
 * left can only be resolved by probing for main/master.
 */
async function blindOriginHead(repoDir: string, originDir: string): Promise<void> {
  await execFileAsync('git', ['--git-dir', originDir, 'symbolic-ref', 'HEAD', 'refs/heads/never-created'], { cwd: originDir });
  try {
    await execFileAsync('git', ['remote', 'set-head', 'origin', '-d'], { cwd: repoDir });
  } catch {
    // Older git doesn't set origin/HEAD on fetch, so there's nothing to delete.
  }
}

test('detectGithubRepo parses an https origin remote', async () => {
  const dir = await makeRepo('https://github.com/acme/widgets.git');
  try {
    assert.equal(detectGithubRepo(dir), 'acme/widgets');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectGithubRepo parses an ssh origin remote', async () => {
  const dir = await makeRepo('git@github.com:acme/widgets.git');
  try {
    assert.equal(detectGithubRepo(dir), 'acme/widgets');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectGithubRepo returns undefined for a non-GitHub remote', async () => {
  const dir = await makeRepo('https://gitlab.example.com/acme/widgets.git');
  try {
    assert.equal(detectGithubRepo(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectGithubRepo returns undefined when there is no origin remote', async () => {
  const dir = await makeRepo();
  try {
    assert.equal(detectGithubRepo(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectGithubRepo returns undefined outside a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-remote-nogit-'));
  try {
    assert.equal(detectGithubRepo(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectDefaultBranch reads origin/HEAD's local symbolic ref when a normal clone already set it", async () => {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-origin-'));
  const cloneDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-clone-'));
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'trunk'], { cwd: originDir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: originDir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: originDir });
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: originDir });

    // A real `git clone` sets refs/remotes/origin/HEAD; a bare `git init` +
    // `remote add` (used by the other tests here) deliberately does not, so
    // this test exercises the fast local path a real clone takes.
    await execFileAsync('git', ['clone', '-q', originDir, cloneDir]);

    assert.equal(await detectDefaultBranch(cloneDir), 'trunk');
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('detectDefaultBranch falls back to asking the remote directly when origin/HEAD was never set locally', async () => {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-origin-'));
  const repoDir = await makeRepo();
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'trunk', '--bare'], { cwd: originDir });
    await execFileAsync('git', ['branch', '-M', 'trunk'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });
    await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoDir });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'trunk'], { cwd: repoDir });

    // origin/HEAD was never set (no `git clone`, no `git remote set-head`) —
    // the local symbolic-ref lookup must fail, forcing the ls-remote fallback.
    assert.equal(await detectDefaultBranch(repoDir), 'trunk');
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('detectDefaultBranch throws a clear error when there is no origin remote to ask at all', async () => {
  const dir = await makeRepo();
  try {
    await assert.rejects(() => detectDefaultBranch(dir), /could not auto-detect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectDefaultBranch probes origin for master when neither symref tier can answer', async () => {
  const { repoDir, originDir } = await makeRepoWithRemoteBranches(['master']);
  try {
    assert.equal(await detectDefaultBranch(repoDir), 'master');
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('detectDefaultBranch probes origin for main when neither symref tier can answer', async () => {
  const { repoDir, originDir } = await makeRepoWithRemoteBranches(['main']);
  try {
    assert.equal(await detectDefaultBranch(repoDir), 'main');
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('detectDefaultBranch still throws when origin has neither main nor master and no symref', async () => {
  const { repoDir, originDir } = await makeRepoWithRemoteBranches(['develop']);
  try {
    await assert.rejects(() => detectDefaultBranch(repoDir), /could not auto-detect/);
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

/** Advances `branch` by one commit on origin, so HEAD's merge-base with it becomes more recent than with the other trunk. */
async function advanceRemoteBranch(repoDir: string, branch: string): Promise<void> {
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', `move ${branch}`], { cwd: repoDir });
  await execFileAsync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: repoDir });
  await execFileAsync('git', ['fetch', '-q', 'origin'], { cwd: repoDir });
}

for (const live of ['main', 'master']) {
  const abandoned = live === 'main' ? 'master' : 'main';
  test(`detectDefaultBranch picks ${live} over ${abandoned} when both exist and HEAD forked from ${live}`, async () => {
    const { repoDir, originDir } = await makeRepoWithRemoteBranches(['main', 'master']);
    try {
      // Both trunks start at the same commit; only `live` keeps moving, and
      // the working branch is cut from its new tip — so HEAD's merge-base
      // with `live` is strictly newer than its merge-base with `abandoned`.
      await advanceRemoteBranch(repoDir, live);
      await execFileAsync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: repoDir });

      assert.equal(await detectDefaultBranch(repoDir), live);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
}

test('remoteBranchExists distinguishes a branch origin has from one it does not', async () => {
  const { repoDir, originDir } = await makeRepoWithRemoteBranches(['main']);
  try {
    assert.equal(await remoteBranchExists(repoDir, 'main'), true);
    assert.equal(await remoteBranchExists(repoDir, 'release/2.0'), false);
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});
