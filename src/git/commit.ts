/** Thin git plumbing wrappers used against the isolated worktree. */

import { execFile } from 'node:child_process';
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

export async function currentSha(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
  return stdout.trim();
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
