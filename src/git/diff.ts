/** Reads the caller's in-progress change set without touching their working tree. */

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CapturedDiff {
  diffText: string;
  changedFiles: string[];
  untrackedFiles: string[];
}

/**
 * Captures staged+unstaged changes (`git diff HEAD`) plus the list of
 * untracked files (which `git diff` never includes) so both can be carried
 * into an isolated worktree.
 *
 * `--full-index` records full (not abbreviated) blob hashes, which
 * worktree.ts's `git apply --3way` needs to reliably locate each blob's
 * common ancestor when the worktree has since been rebased onto a newer
 * origin — otherwise a 3-way merge could fail to resolve an otherwise
 * legitimate abbreviated hash.
 *
 * `--binary` is required so changed binary files (images, etc.) carry their
 * actual base64 patch data instead of a `Binary files a/... differ` stub —
 * without it, `git apply` in worktree.ts fails with "missing binary patch
 * data" for any binary file in the change set.
 *
 * `changedFiles` is captured separately via `--name-only` (a plain path
 * list, no patch data) so callers that only need to *name* what changed —
 * e.g. captureIntent.ts, which lets the agent read each file's diff itself
 * rather than having one embedded in its prompt — never have to hold or
 * scan the full (potentially many-MB, base64-laden) `diffText`.
 */
export async function captureDiff(repoRoot: string): Promise<CapturedDiff> {
  const [{ stdout: diffText }, { stdout: nameOnlyOut }, { stdout: statusOut }] = await Promise.all([
    execFileAsync('git', ['diff', 'HEAD', '--full-index', '--binary'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync('git', ['diff', 'HEAD', '--name-only'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot }),
  ]);

  const changedFiles = nameOnlyOut.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const untrackedFiles = statusOut
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim());

  return { diffText, changedFiles, untrackedFiles };
}

/**
 * Discards repoRoot's now-redundant uncommitted changes once they're safely
 * captured on the opened MR/PR: `git reset --hard HEAD` undoes tracked
 * edits (whatever branch repoRoot happens to be on), then `untrackedFiles`
 * — the same list captureDiff recorded at the start of the run — is deleted
 * individually rather than via a blanket `git clean`, so unrelated
 * untracked files (build output, scratch files) are left alone.
 */
export async function resetRepo(repoRoot: string, untrackedFiles: string[]): Promise<void> {
  await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: repoRoot });
  for (const relativePath of untrackedFiles) {
    rmSync(join(repoRoot, relativePath), { recursive: true, force: true });
  }
}
