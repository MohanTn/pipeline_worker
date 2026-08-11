/**
 * Isolated git worktree management. The caller's own working directory is
 * never touched — all workflow steps run inside a disposable worktree that
 * is always removed afterward (see workflow/orchestrate.ts's and cli.ts's
 * `resume` command's finally blocks).
 */

import { mkdtempSync, mkdirSync, cpSync, writeFileSync, unlinkSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { listConflictedFiles, execGit, withGitRetry } from './commit.js';
import { prepareCommitHooks } from './prepareHooks.js';

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

const OWNED_WORKTREE_PREFIX = join(tmpdir(), 'pipeline-worker-');

function newWorktreeDir(): string {
  const parentDir = mkdtempSync(OWNED_WORKTREE_PREFIX);
  return join(parentDir, 'worktree');
}

/**
 * True when `worktreePath` sits inside a directory pipeline-worker itself
 * created via newWorktreeDir (mkdtemp under os.tmpdir()). removeWorktree's
 * rmSync(dirname(...)) and the failure-path cleanup below are only safe on
 * such paths — checkoutExistingBranch can also hand back a *reused* worktree
 * that belongs to the caller (see findExistingWorktreePath), and blowing
 * away its parent directory would destroy a real checkout on the machine.
 */
function isOwnedWorktreePath(worktreePath: string): boolean {
  return dirname(worktreePath).startsWith(OWNED_WORKTREE_PREFIX);
}

/**
 * Best-effort removal of the mkdtemp dir a failed `git worktree add` leaves
 * behind — newWorktreeDir's parent dir exists before `worktree add` ever
 * runs, so a failure there (bad ref, branch already checked out elsewhere)
 * would otherwise strand an empty `pipeline-worker-XXXXXX` directory under
 * the OS temp dir on every failure. Swallows its own errors: this already
 * runs from a catch block, and a cleanup problem must never mask the real
 * error being rethrown.
 */
function cleanupFailedWorktreeDir(worktreePath: string): void {
  if (!isOwnedWorktreePath(worktreePath)) return;
  try {
    rmSync(dirname(worktreePath), { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to remove temp dir for worktree ${worktreePath}: ${message}`);
  }
}

/** Creates a new worktree off HEAD on a fresh branch, returning its path. */
export async function createWorktree(repoRoot: string, branchName: string): Promise<string> {
  const worktreePath = newWorktreeDir();
  try {
    await execGit(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: repoRoot });
  } catch (error) {
    cleanupFailedWorktreeDir(worktreePath);
    throw error;
  }
  return worktreePath;
}

/**
 * Parses `git worktree list --porcelain` into path/branch pairs. Detached
 * worktrees have no `branch` line and are surfaced with `branch: undefined`.
 */
function parseWorktreeList(output: string): { path: string; branch?: string }[] {
  const entries: { path: string; branch?: string }[] = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

/**
 * The path of the worktree already checked out to `branch` elsewhere on this
 * machine (main working tree included), if any. `git worktree add` refuses
 * to check the same branch out twice, so this is what lets
 * checkoutExistingBranch recover by reusing that worktree instead of failing
 * outright — e.g. running `pipeline-worker fix` from the very checkout that
 * opened the MR/PR in the first place.
 */
export async function findExistingWorktreePath(repoRoot: string, branch: string): Promise<string | undefined> {
  const { stdout } = await execGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  return parseWorktreeList(stdout).find((entry) => entry.branch === branch)?.path;
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
    const { stdout } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
    return stdout.trim() === branch;
  } catch {
    return false;
  }
}

/**
 * True when `worktreePath` is still a usable git worktree, whatever branch it
 * is on. `resume` asks this (rather than isWorktreeOnBranch) before picking a
 * failed run up mid-pipeline: a follow-up run's worktree legitimately sits on
 * the disposable temp branch while the run's state is keyed by the MR/PR's
 * branch, so matching on branch name would reject a perfectly good worktree.
 */
export async function worktreeExists(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  try {
    await execGit(['rev-parse', '--is-inside-work-tree'], { cwd: worktreePath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks out a branch that already exists on origin (used by `pipeline-worker
 * resume`/`review`/`fix` whenever a fresh disposable worktree is needed).
 *
 * If `branch` is already checked out somewhere else on this machine — most
 * commonly the very checkout the user ran `pipeline-worker run` from, now
 * sitting on this branch — `git worktree add` would refuse with "already
 * used by worktree at ...". Rather than fail, that existing worktree is
 * reused as-is: pulled up to date with origin and handed back untouched
 * otherwise. It is never disposable (see isOwnedWorktreePath), so
 * removeWorktree leaves it alone when the run finishes or fails.
 *
 * Otherwise, fetches first and resets a fresh local branch to match
 * origin/branch with `-B` rather than reusing whatever local ref might
 * already exist, so the worktree reflects the branch's actual current state
 * on the forge (what CI is really running against) instead of a possibly
 * stale/diverged local copy.
 */
export async function checkoutExistingBranch(repoRoot: string, branch: string): Promise<string> {
  const existingPath = await findExistingWorktreePath(repoRoot, branch);
  if (existingPath) {
    await syncWithOrigin(existingPath, branch);
    return existingPath;
  }

  const worktreePath = newWorktreeDir();
  try {
    await execGit(['fetch', 'origin', branch], { cwd: repoRoot });
    await execGit(['worktree', 'add', '-B', branch, worktreePath, `origin/${branch}`], { cwd: repoRoot });
  } catch (error) {
    cleanupFailedWorktreeDir(worktreePath);
    throw error;
  }
  // Same dependency link a fresh run gets (see linkNodeModules): without it,
  // every check in the adopted worktree runs against a repo with no
  // node_modules — `npm run build` dies with "tsc: not found" before the
  // branch ever reaches its MR/PR. Safe to link immediately here, unlike on
  // the fresh-run path: nothing replays a `git apply` over this worktree, so
  // there is no index/working-tree mismatch for the symlink to confuse.
  try {
    linkNodeModules(repoRoot, worktreePath);
  } catch (error) {
    console.error(`Warning: failed to link node_modules into ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  await prepareCommitHooks(worktreePath);
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
 *
 * Also used by checkoutExistingBranch to bring a *reused* worktree (the
 * caller's own real checkout, already on `targetBranch`) up to date with
 * origin instead of creating a disposable one. That worktree can genuinely
 * have uncommitted changes; if they collide with the pull, git refuses with
 * its normal "cannot pull with rebase" error, which surfaces to the user
 * exactly like any other command failure here.
 */
export async function syncWithOrigin(worktreePath: string, targetBranch: string): Promise<void> {
  await withGitRetry(() => execGit(['pull', '--rebase', 'origin', targetBranch], { cwd: worktreePath }));
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
    await execGit(['apply', '--3way', '--index', diffFile], { cwd: worktreePath });
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
    await execGit(['add', '-A'], { cwd: worktreePath });
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
  await prepareCommitHooks(worktreePath);
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
      await execGit(['branch', '-m', candidate], { cwd: worktreePath });
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
 * Throws away everything in the worktree that isn't committed: the half
 * applied patch, conflict markers, and copied untracked files a failed `apply`
 * stage left behind. Only ever called on pipeline-worker's own disposable
 * worktree, whose entire content is re-derivable from the caller's repo, so
 * `--hard` + `clean -fd` discards nothing that isn't about to be replayed.
 */
export async function resetWorktree(worktreePath: string): Promise<void> {
  await execGit(['reset', '--hard', 'HEAD'], { cwd: worktreePath });
  await execGit(['clean', '-fd'], { cwd: worktreePath });
}

/**
 * Removes the worktree and the mkdtemp parent directory createWorktree put it
 * in, so a run's disposable worktree never lingers on disk after the flow
 * finishes — success or failure alike, every caller runs this from a
 * finally/cleanup path. Tolerates its own failures (logs + continues) so a
 * cleanup problem never masks the real error from the workflow that called
 * it.
 *
 * No-ops entirely on a worktree pipeline-worker doesn't own (see
 * isOwnedWorktreePath) — checkoutExistingBranch can hand back a *reused*
 * worktree that is the caller's real checkout elsewhere on the machine
 * (branch already checked out there), and both `git worktree remove` and the
 * rmSync below would destroy it rather than a disposable temp dir.
 */
// fallow-ignore-next-line complexity
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  if (!isOwnedWorktreePath(worktreePath)) return;
  try {
    await execGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
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
