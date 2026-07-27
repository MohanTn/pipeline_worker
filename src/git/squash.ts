/**
 * Collapses every commit on `worktreePath`'s current branch since it
 * diverged from `origin/targetBranch` into a single commit titled
 * `commitMessage` — the mechanics behind the opt-in `squashOnMerge` config
 * flag (see orchestrate.ts's finalizeRun). Preserves tree content exactly;
 * `git reset --soft` only rewrites history, never the working tree.
 */

import { mergeBase, commit, execGit } from './commit.js';

async function currentHeadSha(worktreePath: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', 'HEAD'], { cwd: worktreePath });
  return stdout.trim();
}

export async function squashCommitsSinceMergeBase(worktreePath: string, targetBranch: string, commitMessage: string): Promise<void> {
  await execGit(['fetch', 'origin', targetBranch], { cwd: worktreePath });
  const base = await mergeBase(worktreePath, `origin/${targetBranch}`);
  const head = await currentHeadSha(worktreePath);
  if (head === base) {
    throw new Error(`nothing to squash — HEAD is already at the merge-base with origin/${targetBranch}`);
  }
  await execGit(['reset', '--soft', base], { cwd: worktreePath });
  await commit(worktreePath, commitMessage);
}
