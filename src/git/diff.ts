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
  modifiedCount: number;
  deletedCount: number;
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
  const [{ stdout: diffText }, { stdout: nameStatusOut }, { stdout: statusOut }] = await Promise.all([
    execFileAsync('git', ['diff', 'HEAD', '--full-index', '--binary'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync('git', ['diff', 'HEAD', '--name-status'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot }),
  ]);

  const changedFiles: string[] = [];
  let modifiedCount = 0;
  let deletedCount = 0;
  for (const line of nameStatusOut.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)) {
    const [code, ...paths] = line.split('\t');
    changedFiles.push(paths[paths.length - 1]); // renames carry old+new path; keep the new one
    if (code.startsWith('M') || code.startsWith('R')) modifiedCount += 1;
    else if (code.startsWith('D')) deletedCount += 1;
  }
  const untrackedFiles = statusOut
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim());

  return { diffText, changedFiles, untrackedFiles, modifiedCount, deletedCount };
}

/**
 * Names the files that changed since `ref` (typically a merge-base commit —
 * see git/commit.ts's mergeBase), for the `resume` branch-adoption path
 * (adoptBranch.ts) where the change set is already committed rather than
 * sitting uncommitted in repoRoot. Mirrors captureDiff's own `--name-only`
 * call above, just parameterized on the ref instead of hardcoded `HEAD`.
 */
export async function changedFilesSinceRef(worktreePath: string, ref: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', ref], { cwd: worktreePath, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
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
