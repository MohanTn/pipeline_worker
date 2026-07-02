import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGithubRepo } from '../src/git/remote.js';

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
