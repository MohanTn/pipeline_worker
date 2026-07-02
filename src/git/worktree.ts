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
import { listConflictedFiles } from './commit.js';

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
 * Fetches origin and rebases the worktree's branch onto origin/targetBranch,
 * so the diff applied afterward lands on the freshest possible base instead
 * of whatever commit repoRoot's local HEAD happened to be at when the
 * worktree was created. Safe to call before any diff is applied: the
 * worktree has no uncommitted changes yet, so there's nothing for the
 * rebase to conflict with except the diff's own base commit — if that
 * conflicts, git reports it and the run fails clearly, same as a real rebase
 * conflict would for a human.
 */
export async function syncWithOrigin(worktreePath: string, targetBranch: string): Promise<void> {
  await execFileAsync('git', ['pull', '--rebase', 'origin', targetBranch], { cwd: worktreePath });
}

export interface ApplyDiffResult {
  /** True when the diff didn't apply cleanly and left conflict markers for the caller to resolve. */
  conflicted: boolean;
  conflictedFiles: string[];
}

/**
 * Applies a captured diff (staged+unstaged) and copies untracked files into
 * the worktree, so it ends up with exactly the caller's original change set.
 *
 * Uses `--3way`: the diff was captured against repoRoot's HEAD *before*
 * syncWithOrigin rebased the worktree onto the latest origin, so a plain
 * `git apply` can fail outright once origin has moved. `--3way` falls back
 * to a real three-way merge using the blobs recorded in the diff, leaving
 * standard conflict markers (like a merge conflict) instead of a hard
 * failure — the caller resolves them the same way as any other conflict.
 */
export async function applyDiffToWorktree(
  worktreePath: string,
  diffText: string,
  untrackedFiles: string[],
  repoRoot: string,
): Promise<ApplyDiffResult> {
  let conflictedFiles: string[] = [];

  if (diffText.trim().length > 0) {
    const diffFile = join(tmpdir(), `pipeline-worker-diff-${randomUUID()}.patch`);
    writeFileSync(diffFile, diffText, 'utf-8');
    try {
      await execFileAsync('git', ['apply', '--3way', '--index', diffFile], { cwd: worktreePath });
    } catch (error) {
      conflictedFiles = await listConflictedFiles(worktreePath);
      if (conflictedFiles.length === 0) throw error; // not a recoverable conflict — surface the real error
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

  if (untrackedFiles.length > 0 && conflictedFiles.length === 0) {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  }

  return { conflicted: conflictedFiles.length > 0, conflictedFiles };
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
