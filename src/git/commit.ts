/** Thin git plumbing wrappers used against the isolated worktree. */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecGitOptions {
  cwd: string;
  maxBuffer?: number;
}

/**
 * Runs `git <args>`, rethrowing on failure with stdout folded into the error
 * message when stderr is empty. Node's execFile error message is built from
 * stderr only, but some git failures print entirely to stdout — e.g. `git
 * commit` with nothing staged prints "nothing to commit, working tree
 * clean" there, not to stderr — so without this, those failures surface to
 * the user as a bare "Command failed: git ..." with no indication of what
 * actually went wrong.
 */
export async function execGit(args: string[], options: ExecGitOptions): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, options);
  } catch (error) {
    if (error instanceof Error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? '').trim();
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
      if (stdout.length > 0 && stderr.length === 0) {
        error.message = `${error.message.trim()}\n${stdout}`;
      }
    }
    throw error;
  }
}

export async function stageAll(worktreePath: string): Promise<void> {
  await execGit(['add', '-A'], { cwd: worktreePath });
}

/**
 * Commits staged changes. Retries once if a pre-commit hook (husky running
 * `dotnet format`, lint-staged, etc.) auto-fixes files as a side effect and
 * then fails the hook itself — that aborts the first `git commit` with the
 * fixed files left unstaged, which otherwise surfaces as a spurious "failed
 * to commit" even though nothing actually needs a human. Detected by
 * snapshotting `git status --porcelain` before the attempt: if it differs
 * afterward, the hook touched the tree, so this re-stages and commits again.
 * A hook failure that leaves the tree untouched (a real lint/test/build
 * failure) is not retried and surfaces as-is.
 */
export async function commit(worktreePath: string, message: string): Promise<void> {
  const before = await gitStatus(worktreePath);
  try {
    await execGit(['commit', '-m', message], { cwd: worktreePath });
  } catch (error) {
    const after = await gitStatus(worktreePath);
    if (after === before) throw error;
    await stageAll(worktreePath);
    try {
      await execGit(['commit', '-m', message], { cwd: worktreePath });
    } catch (retryError) {
      if (retryError instanceof Error) {
        retryError.message = `${retryError.message.trim()}\n(retried once after a pre-commit hook modified files; still failing)`;
      }
      throw retryError;
    }
  }
}

async function gitStatus(worktreePath: string): Promise<string> {
  const { stdout } = await execGit(['status', '--porcelain'], { cwd: worktreePath });
  return stdout;
}

/**
 * Pushes the worktree's HEAD to `remote`'s `branch`. Deliberately an explicit
 * `HEAD:refs/heads/<branch>` refspec rather than the bare branch name: a
 * follow-up run adding a commit to an already-open MR/PR works in a worktree
 * whose *local* branch is still the disposable temp branch (the PR's own
 * branch is checked out in repoRoot, and git refuses to check out one branch
 * in two worktrees), so the local and remote names differ there. For a normal
 * run the two are the same and this is exactly `git push -u origin <branch>`.
 */
export async function push(worktreePath: string, remote: string, branch: string): Promise<void> {
  await execGit(['push', '--set-upstream', remote, `HEAD:refs/heads/${branch}`], { cwd: worktreePath });
}

/**
 * Force-pushes with `--force-with-lease`, never plain `--force`: the lease
 * refuses the push if `remote`'s branch has moved since we last observed it
 * (a stray commit from elsewhere, a human pushing a fixup), failing loudly
 * instead of silently discarding that work. Used only by the opt-in
 * squash-on-merge step (git/squash.ts), the one operation in this tool that
 * rewrites already-pushed history.
 */
export async function forcePushWithLease(worktreePath: string, remote: string, branch: string): Promise<void> {
  await execGit(['push', '--force-with-lease', remote, `HEAD:refs/heads/${branch}`], { cwd: worktreePath });
}

/** True when the worktree has staged, unstaged, or untracked changes. */
export async function hasChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await execGit(['status', '--porcelain'], { cwd: worktreePath });
  return stdout.trim().length > 0;
}

/** Files git still reports as unmerged — conflict markers from a `git apply --3way` or `git merge` not yet resolved and staged. */
export async function listConflictedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execGit(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreePath });
  return stdout.trim().split('\n').filter(Boolean);
}

const CONFLICT_MARKER = /^(<{7} |>{7} )/m;

/**
 * Which of `files` still literally contain an unresolved `<<<<<<<`/`>>>>>>>`
 * conflict marker line. Deliberately reads file content rather than reusing
 * listConflictedFiles: git's index keeps a file flagged "unmerged" until
 * `git add` re-stages it, regardless of whether its content still has
 * markers — so checking the index right after an editor (human or agent)
 * fixes the content, but before staging, would always report "still
 * conflicted" even when it's actually resolved. Checking content directly
 * also catches the opposite mistake: `git add` doesn't validate content, so
 * staging first and then checking the index would silently accept a file
 * that still has markers in it.
 */
export function findUnresolvedConflictMarkers(worktreePath: string, files: string[]): string[] {
  return files.filter((file) => CONFLICT_MARKER.test(readFileSync(join(worktreePath, file), 'utf-8')));
}

export async function findRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--show-toplevel'], { cwd });
  return stdout.trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

/**
 * Checks out a branch that already exists locally. Used at the end of a run
 * to leave repoRoot standing on the feature branch it just built (see
 * orchestrate.ts's maybeSwitchToFeatureBranch) — the run's own worktree must
 * be gone first, since git refuses to check one branch out in two worktrees.
 */
export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  await execGit(['checkout', branch], { cwd });
}

/**
 * The commit where HEAD diverged from `ref`. Used by the `resume` branch-
 * adoption path (adoptBranch.ts) to pin captureIntent's diff instructions to
 * a single fixed commit — `git diff <mergeBaseSha> -- <file>` — so the agent
 * sees exactly the adopted branch's own changes regardless of how many
 * commits it has, the same way a normal run's `git diff HEAD -- <file>` shows
 * exactly its (single, uncommitted) change set.
 */
export async function mergeBase(worktreePath: string, ref: string): Promise<string> {
  const { stdout } = await execGit(['merge-base', ref, 'HEAD'], { cwd: worktreePath });
  return stdout.trim();
}

/** Reads git config user.name/user.email for display purposes; never throws — unset config just reads as ''. */
export async function getGitUser(cwd: string): Promise<{ name: string; email: string }> {
  async function readConfig(key: string): Promise<string> {
    try {
      const { stdout } = await execGit(['config', key], { cwd });
      return stdout.trim();
    } catch {
      return '';
    }
  }
  const [name, email] = await Promise.all([readConfig('user.name'), readConfig('user.email')]);
  return { name, email };
}
