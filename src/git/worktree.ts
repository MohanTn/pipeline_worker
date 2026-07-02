/**
 * Isolated git worktree management. The caller's own working directory is
 * never touched — all workflow steps run inside a disposable worktree that
 * is always removed afterward (see workflow/orchestrate.ts's finally block).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, unlinkSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

const execFileAsync = promisify(execFile);

export function generateTempBranchName(): string {
  return `pipeline-worker/tmp-${randomUUID().slice(0, 8)}`;
}

/**
 * Creates a new worktree off HEAD on a fresh branch, returning its path.
 *
 * git worktrees don't include node_modules (it's gitignored, not tracked), so
 * build/lint/test would otherwise fail on a missing toolchain in every repo
 * that has one. Symlinking the source repo's node_modules in is the same
 * trick turbo/lerna use for worktree-based tooling: instant, no network, and
 * safe because node_modules is never part of the diff being tested.
 */
export async function createWorktree(repoRoot: string, branchName: string): Promise<string> {
  const parentDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-'));
  const worktreePath = join(parentDir, 'worktree');
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: repoRoot });

  const sourceNodeModules = join(repoRoot, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, join(worktreePath, 'node_modules'), 'dir');
  }

  return worktreePath;
}

/**
 * Applies a captured diff (staged+unstaged) and copies untracked files into
 * the worktree, so it ends up with exactly the caller's original change set.
 */
export async function applyDiffToWorktree(
  worktreePath: string,
  diffText: string,
  untrackedFiles: string[],
  repoRoot: string,
): Promise<void> {
  if (diffText.trim().length > 0) {
    const diffFile = join(tmpdir(), `pipeline-worker-diff-${randomUUID()}.patch`);
    writeFileSync(diffFile, diffText, 'utf-8');
    try {
      await execFileAsync('git', ['apply', '--index', diffFile], { cwd: worktreePath });
    } finally {
      unlinkSync(diffFile);
    }
  }

  for (const relativePath of untrackedFiles) {
    const src = join(repoRoot, relativePath);
    const dest = join(worktreePath, relativePath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }

  if (untrackedFiles.length > 0) {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  }
}

/** Renames the worktree's current branch (used once the agent has proposed a real name). */
export async function renameBranch(worktreePath: string, newBranchName: string): Promise<void> {
  await execFileAsync('git', ['branch', '-m', newBranchName], { cwd: worktreePath });
}

/**
 * Removes the worktree and the mkdtemp parent directory createWorktree put it
 * in. Tolerates its own failures (logs + continues) so a cleanup problem
 * never masks the real error from the workflow that called it.
 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to remove worktree ${worktreePath}: ${message}`);
  }

  // createWorktree puts worktreePath inside a dedicated mkdtemp parent dir
  // (<tmp>/pipeline-worker-XXXX/worktree) precisely so it can be discarded wholesale here.
  try {
    rmSync(dirname(worktreePath), { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to remove temp dir for worktree ${worktreePath}: ${message}`);
  }
}
