import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGitUser } from '../src/git/commit.js';

const execFileAsync = promisify(execFile);

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
