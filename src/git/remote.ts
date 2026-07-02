/**
 * Auto-detects the GitHub `owner/name` slug from the repo's own `origin`
 * remote, so PIPELINE_WORKER_GITHUB_REPO only needs to be set for repos
 * where that detection doesn't apply (e.g. origin isn't GitHub).
 */

import { execFileSync } from 'node:child_process';

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
