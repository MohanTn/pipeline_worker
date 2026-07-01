/** Reads the caller's in-progress change set without touching their working tree. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CapturedDiff {
  diffText: string;
  untrackedFiles: string[];
}

/**
 * Captures staged+unstaged changes (`git diff HEAD`) plus the list of
 * untracked files (which `git diff` never includes) so both can be carried
 * into an isolated worktree.
 */
export async function captureDiff(repoRoot: string): Promise<CapturedDiff> {
  const { stdout: diffText } = await execFileAsync('git', ['diff', 'HEAD'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });

  const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot });
  const untrackedFiles = statusOut
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim());

  return { diffText, untrackedFiles };
}
