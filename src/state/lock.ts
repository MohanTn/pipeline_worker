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

/**
 * Acquires the lock, throwing if another live process already holds it. A
 * lock left behind by a process that's no longer running (crash, kill -9) is
 * treated as stale and reclaimed. Returns a release function; safe to call
 * more than once.
 *
 * The final write uses the 'wx' flag (fails with EEXIST if the path already
 * exists) as the actual mutual-exclusion guard — the existsSync/liveness
 * check above is only a fast path to produce a clear "who's holding it"
 * error message, since it's inherently racy against another process doing
 * the same check concurrently.
 */
export function acquireLock(repoRoot: string): () => void {
  const dir = join(repoRoot, '.pipeline-worker');
  mkdirSync(dir, { recursive: true });
  const path = lockPath(repoRoot);

  if (existsSync(path)) {
    const heldPid = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (Number.isInteger(heldPid) && isProcessAlive(heldPid)) {
      throw new Error(
        `pipeline-worker: another run (pid ${heldPid}) is already in progress in this repo. ` +
          'Wait for it to finish, or if it crashed without cleaning up, remove .pipeline-worker/run.lock.',
      );
    }
    removeIfPresent(path);
  }

  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
  } catch {
    throw new Error('pipeline-worker: another run just started in this repo — try again.');
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeIfPresent(path);
  };
}
