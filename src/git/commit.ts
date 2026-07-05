/** Thin git plumbing wrappers used against the isolated worktree. */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function stageAll(worktreePath: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
}

export async function commit(worktreePath: string, message: string): Promise<void> {
  await execFileAsync('git', ['commit', '-m', message], { cwd: worktreePath });
}

export async function push(worktreePath: string, remote: string, branch: string): Promise<void> {
  await execFileAsync('git', ['push', '--set-upstream', remote, branch], { cwd: worktreePath });
}

/** True when the worktree has staged, unstaged, or untracked changes. */
export async function hasChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath });
  return stdout.trim().length > 0;
}

/** Files git still reports as unmerged — conflict markers from a `git apply --3way` or `git merge` not yet resolved and staged. */
export async function listConflictedFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: worktreePath });
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

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

/** Reads git config user.name/user.email for display purposes; never throws — unset config just reads as ''. */
export async function getGitUser(cwd: string): Promise<{ name: string; email: string }> {
  async function readConfig(key: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['config', key], { cwd });
      return stdout.trim();
    } catch {
      return '';
    }
  }
  const [name, email] = await Promise.all([readConfig('user.name'), readConfig('user.email')]);
  return { name, email };
}
