/**
 * Isolated git worktree management. The caller's own working directory is
 * never touched — all workflow steps run inside a disposable worktree that
 * is always removed afterward (see workflow/orchestrate.ts's and cli.ts's
 * `resume` command's finally blocks).
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
 * Points worktreePath/node_modules at repoRoot/node_modules. git worktrees
 * don't include node_modules (it's normally gitignored, not tracked), so
 * build/lint/test would otherwise fail on a missing toolchain in every repo
 * that has one. Symlinking the source repo's node_modules in is the same
 * trick turbo/lerna use for worktree-based tooling: instant, no network, and
 * safe because node_modules is never part of the diff being tested.
 *
 * Called only from applyDiffToWorktree, once the diff is fully applied —
 * never from createWorktree. If node_modules was ever accidentally
 * committed (as happened in this very repo), `git apply` needs to see the
 * worktree exactly as `git worktree add` checked it out; pre-placing a
 * symlink here would make that tracked path's working-tree content diverge
 * from git's index before git apply runs, and its behavior on a mismatch
 * ranges from silently dropping the symlink to rejecting the hunk outright.
 * Linking only after the apply step sidesteps that entirely.
 */
function linkNodeModules(repoRoot: string, worktreePath: string): void {
  const sourceNodeModules = join(repoRoot, 'node_modules');
  if (!existsSync(sourceNodeModules)) return;
  const destNodeModules = join(worktreePath, 'node_modules');
  try {
    unlinkSync(destNodeModules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  symlinkSync(sourceNodeModules, destNodeModules, 'dir');
}

function newWorktreeDir(): string {
  const parentDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-'));
  return join(parentDir, 'worktree');
}

/** Creates a new worktree off HEAD on a fresh branch, returning its path. */
export async function createWorktree(repoRoot: string, branchName: string): Promise<string> {
  const worktreePath = newWorktreeDir();
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: repoRoot });
  return worktreePath;
}

/**
 * True when `worktreePath` still exists and is checked out to exactly
 * `branch` — the narrow case where a crashed run's original worktree
 * survived (e.g. a SIGKILL that skipped orchestrate.ts's cleanup). Any
 * failure (path missing, not a git worktree, detached HEAD) is treated as
 * "not valid" rather than thrown, since the caller's fallback
 * (checkoutExistingBranch) is always safe to fall back on.
 */
export async function isWorktreeOnBranch(worktreePath: string, branch: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
    return stdout.trim() === branch;
  } catch {
    return false;
  }
}

/**
 * Checks out a branch that already exists on origin (used by `pipeline-worker
 * resume`, where the original worktree from the crashed run is normally
 * already gone — see orchestrate.ts's unconditional cleanup). Fetches first
 * and resets the local branch to match origin/branch with `-B` rather than
 * reusing whatever local ref might already exist, so the worktree reflects
 * the branch's actual current state on the forge (what CI is really running
 * against) instead of a possibly stale/diverged local copy.
 */
export async function checkoutExistingBranch(repoRoot: string, branch: string): Promise<string> {
  const worktreePath = newWorktreeDir();
  await execFileAsync('git', ['fetch', 'origin', branch], { cwd: repoRoot });
  await execFileAsync('git', ['worktree', 'add', '-B', branch, worktreePath, `origin/${branch}`], { cwd: repoRoot });
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
 * Applies the captured diff via `git apply --3way`, returning conflicted
 * files if the 3-way merge left conflict markers (empty when diffText is
 * blank, or the diff applied cleanly). Uses `--3way` because the diff was
 * captured against repoRoot's HEAD *before* syncWithOrigin rebased the
 * worktree onto the latest origin, so a plain `git apply` can fail outright
 * once origin has moved; `--3way` falls back to a real three-way merge using
 * the blobs recorded in the diff, leaving standard conflict markers (like a
 * merge conflict) instead of a hard failure. Kept as one function: the
 * catch/rethrow decision below depends on the same `error` the try produced,
 * so splitting the two would need to pass the error back out artificially.
 */
async function applyDiffPatch(worktreePath: string, diffText: string): Promise<string[]> {
  if (diffText.trim().length === 0) return [];

  const diffFile = join(tmpdir(), `pipeline-worker-diff-${randomUUID()}.patch`);
  writeFileSync(diffFile, diffText, 'utf-8');
  try {
    await execFileAsync('git', ['apply', '--3way', '--index', diffFile], { cwd: worktreePath });
    return [];
  } catch (error) {
    const conflictedFiles = await listConflictedFiles(worktreePath);
    if (conflictedFiles.length === 0) throw error; // not a recoverable conflict — surface the real error
    return conflictedFiles;
  } finally {
    unlinkSync(diffFile);
  }
}

function copyUntrackedFiles(repoRoot: string, worktreePath: string, untrackedFiles: string[]): void {
  for (const relativePath of untrackedFiles) {
    const src = join(repoRoot, relativePath);
    const dest = join(worktreePath, relativePath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
}

async function stageUntrackedIfNeeded(worktreePath: string, untrackedFiles: string[], conflictedFiles: string[]): Promise<void> {
  if (untrackedFiles.length > 0 && conflictedFiles.length === 0) {
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  }
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
): Promise<ApplyDiffResult> {
  const conflictedFiles = await applyDiffPatch(worktreePath, diffText);
  copyUntrackedFiles(repoRoot, worktreePath, untrackedFiles);
  await stageUntrackedIfNeeded(worktreePath, untrackedFiles, conflictedFiles);
  linkNodeModules(repoRoot, worktreePath);
  return { conflicted: conflictedFiles.length > 0, conflictedFiles };
}

/** How many collision retries renameBranch attempts before giving up. */
const RENAME_BRANCH_MAX_ATTEMPTS = 5;

/**
 * Renames the worktree's current branch (used once the agent has proposed a
 * real name), returning the branch name actually applied. If newBranchName
 * collides with a branch that already exists locally (e.g. two runs both
 * inferring the same descriptive slug), retries with a short random suffix
 * appended instead of failing the run outright.
 */
// fallow-ignore-next-line complexity
export async function renameBranch(worktreePath: string, newBranchName: string): Promise<string> {
  let candidate = newBranchName;
  for (let attempt = 1; attempt <= RENAME_BRANCH_MAX_ATTEMPTS; attempt++) {
    try {
      await execFileAsync('git', ['branch', '-m', candidate], { cwd: worktreePath });
      return candidate;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (!/already exists/.test(stderr) || attempt === RENAME_BRANCH_MAX_ATTEMPTS) throw error;
      candidate = `${newBranchName}-${randomUUID().slice(0, 6)}`;
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error(`pipeline-worker: could not rename branch to a variant of "${newBranchName}"`);
}

/**
 * Removes the worktree and the mkdtemp parent directory createWorktree put it
 * in. Tolerates its own failures (logs + continues) so a cleanup problem
 * never masks the real error from the workflow that called it.
 */
// fallow-ignore-next-line complexity
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
