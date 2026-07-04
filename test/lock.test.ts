import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../src/state/lock.js';

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'pipeline-worker-lock-'));
}

function lockPath(dir: string): string {
  return join(dir, '.pipeline-worker', 'run.lock');
}

test('acquireLock writes the current pid to the lockfile, and release() removes it', () => {
  const dir = tmpRepo();
  try {
    const release = acquireLock(dir);
    assert.ok(existsSync(lockPath(dir)));
    assert.equal(readFileSync(lockPath(dir), 'utf-8'), String(process.pid));

    release();
    assert.equal(existsSync(lockPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock throws when another live process already holds the lock', () => {
  const dir = tmpRepo();
  try {
    mkdirSync(join(dir, '.pipeline-worker'), { recursive: true });
    // process.pid is guaranteed alive during this test, simulating a concurrent run holding the lock.
    writeFileSync(lockPath(dir), String(process.pid));
    assert.throws(() => acquireLock(dir), /already in progress/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock reclaims a stale lock left by a process that is no longer running', () => {
  const dir = tmpRepo();
  try {
    mkdirSync(join(dir, '.pipeline-worker'), { recursive: true });
    // Above Linux's default pid_max — not a live process to collide with.
    writeFileSync(lockPath(dir), '999999999');

    const release = acquireLock(dir);
    assert.equal(readFileSync(lockPath(dir), 'utf-8'), String(process.pid));
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release() is idempotent', () => {
  const dir = tmpRepo();
  try {
    const release = acquireLock(dir);
    release();
    assert.doesNotThrow(() => release());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
