import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGithubRepo, detectDefaultBranch } from '../src/git/remote.js';

const execFileAsync = promisify(execFile);

async function makeRepo(remoteUrl?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-remote-'));
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  if (remoteUrl) await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
  return dir;
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
