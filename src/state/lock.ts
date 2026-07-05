/**
 * A per-repo lockfile at <repoRoot>/.pipeline-worker/run.lock, preventing two
 * `pipeline-worker run` invocations from racing against the same working
 * tree — e.g. one instance's `resetRepo` (`git reset --hard`) wiping out
 * uncommitted changes another instance's `captureDiff` hasn't processed yet.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function lockPath(repoRoot: string): string {
  return join(repoRoot, '.pipeline-worker', 'run.lock');
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing but still validates the pid exists/is
    // accessible — the standard liveness check on POSIX and Windows.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone (e.g. a concurrent process reclaimed it first) — fine.
  }
}

function readLockHolderPid(path: string): number | undefined {
  const heldPid = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
  return Number.isInteger(heldPid) ? heldPid : undefined;
}

/**
 * Throws if the lock is held by a still-alive process; otherwise removes a
 * stale lock left by one that's no longer running (crash, kill -9). This is
 * only a fast path for a clear "who's holding it" error message — it's
 * inherently racy against another process doing the same check concurrently,
 * so writeLockFileExclusive below is the actual mutual-exclusion guard.
 */
function assertLockNotHeld(path: string): void {
  if (!existsSync(path)) return;
  const heldPid = readLockHolderPid(path);
  if (heldPid !== undefined && isProcessAlive(heldPid)) {
    throw new Error(
      `pipeline-worker: another run (pid ${heldPid}) is already in progress in this repo. ` +
        'Wait for it to finish, or if it crashed without cleaning up, remove .pipeline-worker/run.lock.',
    );
  }
  removeIfPresent(path);
}

/** The 'wx' flag fails with EEXIST if the path already exists — this, not assertLockNotHeld's check above, is what actually closes the race between two concurrent acquirers. */
function writeLockFileExclusive(path: string): void {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
  } catch {
    throw new Error('pipeline-worker: another run just started in this repo — try again.');
  }
}

function makeIdempotentReleaser(path: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeIfPresent(path);
  };
}

/**
 * Acquires the lock, throwing if another live process already holds it. A
 * lock left behind by a process that's no longer running (crash, kill -9) is
 * treated as stale and reclaimed. Returns a release function; safe to call
 * more than once.
 */
export function acquireLock(repoRoot: string): () => void {
  const dir = join(repoRoot, '.pipeline-worker');
  mkdirSync(dir, { recursive: true });
  const path = lockPath(repoRoot);

  assertLockNotHeld(path);
  writeLockFileExclusive(path);

  return makeIdempotentReleaser(path);
}
