/**
 * Auto-detects the GitHub `owner/name` slug from the repo's own `origin`
 * remote, so PIPELINE_WORKER_GITHUB_REPO only needs to be set for repos
 * where that detection doesn't apply (e.g. origin isn't GitHub), plus
 * origin's default branch (`main`/`master`), which both `run` and `resume`
 * use as the MR/PR's target branch.
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
const HEAD_LINE = /refs\/heads\/(\S+)$/;

/**
 * The conventional trunk names, in the order they win a tie that nothing
 * else can break. Probed as detectDefaultBranch's last tier, so a repo whose
 * `origin/HEAD` was never set (shallow/single-branch clone, worktree-only
 * checkout) still resolves `main` or `master` instead of failing outright.
 */
const CONVENTIONAL_DEFAULT_BRANCHES = ['main', 'master'];

/**
 * Every remote query below runs with terminal prompting disabled: an https
 * origin with no cached credentials would otherwise sit waiting for a
 * username at the very start of an unattended run. Failing immediately is
 * the right answer — each caller already treats "couldn't ask origin" as a
 * reason to fall back, not to stop.
 */
function remoteQueryOptions(repoRoot: string): { cwd: string; env: NodeJS.ProcessEnv } {
  return { cwd: repoRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
}

/** True when `branch` exists as a head on `origin`. Throws only when origin itself can't be reached. */
export async function remoteBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], remoteQueryOptions(repoRoot));
  return stdout.trim().length > 0;
}

/** Which of `branches` origin actually has, in the order they were asked for. */
async function listRemoteHeads(repoRoot: string, branches: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', ...branches], remoteQueryOptions(repoRoot));
  const present = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = HEAD_LINE.exec(line.trim());
    if (match) present.add(match[1]);
  }
  return branches.filter((branch) => present.has(branch));
}

/** `git merge-base --is-ancestor a b` — true when commit `a` is an ancestor of commit `b`. */
async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * A repo mid-migration has both `main` and `master` and no origin/HEAD to
 * break the tie: pick the one whose merge-base with the current HEAD is the
 * more recent commit — i.e. the branch HEAD actually forked from, rather
 * than the abandoned one that stopped moving at the migration point. Any
 * candidate whose remote-tracking ref isn't present locally (never fetched)
 * simply can't be compared and loses; a genuine tie falls back to
 * CONVENTIONAL_DEFAULT_BRANCHES order.
 */
async function preferByMergeBase(repoRoot: string, candidates: string[]): Promise<string> {
  const bases: Array<{ branch: string; sha: string }> = [];
  for (const branch of candidates) {
    try {
      const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', `refs/remotes/origin/${branch}`], { cwd: repoRoot });
      bases.push({ branch, sha: stdout.trim() });
    } catch {
      // No local remote-tracking ref, or unrelated histories — not comparable.
    }
  }
  if (bases.length < 2) return bases[0]?.branch ?? candidates[0];

  const [first, second] = bases;
  if (first.sha === second.sha) return candidates[0];
  if (await isAncestor(repoRoot, first.sha, second.sha)) return second.branch;
  if (await isAncestor(repoRoot, second.sha, first.sha)) return first.branch;
  return candidates[0];
}

/** Last tier: ask origin which of the conventional trunk names it actually has. */
async function probeConventionalDefault(repoRoot: string): Promise<string | undefined> {
  let present: string[];
  try {
    present = await listRemoteHeads(repoRoot, CONVENTIONAL_DEFAULT_BRANCHES);
  } catch {
    return undefined; // origin unreachable — the caller falls back to the current branch
  }
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return preferByMergeBase(repoRoot, present);
}

/**
 * True unless origin is reachable *and* says the branch is gone — a stale
 * `refs/remotes/origin/HEAD` pointing at a branch deleted during a
 * main/master rename must not become the target, but an unreachable origin
 * (offline, VPN down) is no reason to distrust the local symref either.
 */
async function symrefStillOnOrigin(repoRoot: string, branch: string): Promise<boolean> {
  try {
    return await remoteBranchExists(repoRoot, branch);
  } catch {
    return true;
  }
}

/**
 * Auto-detects `origin`'s default branch (e.g. "main"): the target branch a
 * `pipeline-worker run` opens its MR/PR against (see orchestrate.ts's
 * resolveTargetBranch), and the base `resume`'s branch-adoption path opens
 * one against when the adopted branch has no PR/MR yet.
 *
 * Three tiers, cheapest first:
 *   a. the local `refs/remotes/origin/HEAD` symbolic ref a normal `git clone`
 *      establishes — validated against origin, since a main/master rename
 *      leaves it pointing at a branch that no longer exists;
 *   b. asking the remote directly (`git ls-remote --symref`), for repos where
 *      that ref was never set (shallow/single-branch clones, worktree-only
 *      checkouts);
 *   c. probing origin for `main` then `master` — a repo can have neither a
 *      local symref nor a remote HEAD symref and still obviously be on one
 *      of the two conventional trunks.
 */
export async function detectDefaultBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot });
    const branch = stdout.trim().replace(/^origin\//, '');
    if (branch && (await symrefStillOnOrigin(repoRoot, branch))) return branch;
  } catch {
    // origin/HEAD not set locally — fall through to asking the remote.
  }

  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], remoteQueryOptions(repoRoot));
    const match = SYMREF_LINE.exec(stdout);
    if (match) return match[1];
  } catch {
    // Remote unreachable or no origin at all — the probe below fails the same way.
  }

  const probed = await probeConventionalDefault(repoRoot);
  if (probed) return probed;

  throw new Error("pipeline-worker: could not auto-detect origin's default branch — pass --target <branch> explicitly.");
}
