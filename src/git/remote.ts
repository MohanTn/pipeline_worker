/**
 * Auto-detects the GitHub `owner/name` slug from the repo's own `origin`
 * remote, so PIPELINE_WORKER_GITHUB_REPO only needs to be set for repos
 * where that detection doesn't apply (e.g. origin isn't GitHub).
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GITHUB_REMOTE = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/;

/** Returns the `owner/name` slug for repoRoot's `origin` remote, or undefined if it's missing or not a GitHub remote. */
export function detectGithubRepo(repoRoot: string): string | undefined {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
  return url.match(GITHUB_REMOTE)?.[1];
}

const SYMREF_LINE = /ref:\s+refs\/heads\/(\S+)\s+HEAD/;

/**
 * Auto-detects `origin`'s default branch (e.g. "main"), for `resume`'s
 * branch-adoption path: when it checks out a branch pipeline-worker never
 * created and finds no open PR/MR yet, it needs *some* base branch to open
 * one against, and there's no local repoRoot branch to infer it from (unlike
 * `pipeline-worker run`, which just uses whatever branch the caller was on).
 *
 * Tries the fast, local `refs/remotes/origin/HEAD` symbolic ref first — set
 * whenever a normal `git clone` established it — falling back to asking the
 * remote directly (`git ls-remote --symref`) for repos where it was never
 * set (shallow/single-branch clones, or a worktree-only checkout).
 */
export async function detectDefaultBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot });
    return stdout.trim().replace(/^origin\//, '');
  } catch {
    // origin/HEAD not set locally — fall through to asking the remote.
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: repoRoot }));
  } catch {
    throw new Error("pipeline-worker: could not auto-detect origin's default branch — pass --target <branch> explicitly.");
  }
  const match = SYMREF_LINE.exec(stdout);
  if (!match) {
    throw new Error("pipeline-worker: could not auto-detect origin's default branch — pass --target <branch> explicitly.");
  }
  return match[1];
}
