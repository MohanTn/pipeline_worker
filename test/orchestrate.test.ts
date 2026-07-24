import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldPreserveWorktreeOnInterrupt, resolveTargetBranch, findFollowUpMr } from '../src/workflow/orchestrate.js';
import type { ForgeClient } from '../src/forge/types.js';
import type { MergeRequest } from '../src/types.js';

const execFileAsync = promisify(execFile);

test('shouldPreserveWorktreeOnInterrupt keeps the worktree once an MR/PR is open (resume needs it)', () => {
  assert.equal(shouldPreserveWorktreeOnInterrupt('mr'), true);
  assert.equal(shouldPreserveWorktreeOnInterrupt('watch'), true);
});

test('shouldPreserveWorktreeOnInterrupt removes the worktree before any MR/PR exists', () => {
  assert.equal(shouldPreserveWorktreeOnInterrupt('diff'), false);
  assert.equal(shouldPreserveWorktreeOnInterrupt('intent'), false);
  assert.equal(shouldPreserveWorktreeOnInterrupt('checks'), false);
});

test('shouldPreserveWorktreeOnInterrupt removes the worktree once the run reached a terminal phase', () => {
  assert.equal(shouldPreserveWorktreeOnInterrupt('done'), false);
  assert.equal(shouldPreserveWorktreeOnInterrupt('escalated'), false);
});

/** A repo on `branch`, pushed to a bare origin whose default branch is `defaultBranch`. */
async function makeRepoWithOrigin(defaultBranch: string, branch: string): Promise<{ repoDir: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-target-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-target-repo-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', defaultBranch], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', defaultBranch], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoDir });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', defaultBranch], { cwd: repoDir });
  if (branch !== defaultBranch) await execFileAsync('git', ['checkout', '-q', '-b', branch], { cwd: repoDir });
  return { repoDir, originDir };
}

async function withRepo(defaultBranch: string, branch: string, fn: (repoDir: string) => Promise<void>): Promise<void> {
  const { repoDir, originDir } = await makeRepoWithOrigin(defaultBranch, branch);
  try {
    await fn(repoDir);
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
}

for (const defaultBranch of ['main', 'master']) {
  test(`resolveTargetBranch targets ${defaultBranch} from a feature branch, not the branch you are standing on`, () =>
    withRepo(defaultBranch, 'feat/x', async (repoDir) => {
      assert.equal(await resolveTargetBranch(repoDir), defaultBranch);
    }));
}

test('resolveTargetBranch prefers an explicit --target over detection', () =>
  withRepo('main', 'feat/x', async (repoDir) => {
    await execFileAsync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/release/2.0'], { cwd: repoDir });
    assert.equal(await resolveTargetBranch(repoDir, 'release/2.0'), 'release/2.0');
  }));

test('resolveTargetBranch rejects a --target that does not exist on origin, before any worktree is created', () =>
  withRepo('main', 'feat/x', async (repoDir) => {
    await assert.rejects(() => resolveTargetBranch(repoDir, 'release/9.9'), /does not exist on origin/);
  }));

test('resolveTargetBranch falls back to the current branch when the repo has no origin at all', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-target-noorigin-'));
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'wip'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });

    assert.equal(await resolveTargetBranch(repoDir), 'wip');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('resolveTargetBranch refuses to guess from a detached HEAD with no origin to fall back on', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-target-detached-'));
  try {
    await execFileAsync('git', ['init', '-q', '-b', 'wip'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });
    await execFileAsync('git', ['checkout', '-q', '--detach'], { cwd: repoDir });

    await assert.rejects(() => resolveTargetBranch(repoDir), /detached HEAD/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

/** Only findExistingMr matters here; every other call would be a bug in the code under test. */
function lookupOnlyForge(onLookup: (branch: string) => MergeRequest | undefined): { forge: ForgeClient; branches: string[] } {
  const branches: string[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error('not used');
  };
  const forge = {
    findExistingMr: async (branch: string) => {
      branches.push(branch);
      return onLookup(branch);
    },
    createMergeRequest: notUsed,
    updateMrDescription: notUsed,
    getMrDescription: notUsed,
    getMrPipelines: notUsed,
    getFailedJobs: notUsed,
    getJobLog: notUsed,
    retryPipeline: notUsed,
    createMrNote: notUsed,
    hasMergeConflicts: notUsed,
    enableAutoMerge: notUsed,
    isMrMerged: notUsed,
    getCiConfigPath: notUsed,
  } as unknown as ForgeClient;
  return { forge, branches };
}

const OPEN_MR: MergeRequest = { iid: 12, webUrl: 'http://example/mr/12', sourceBranch: 'feat/x', targetBranch: 'main', state: 'open' };

test("findFollowUpMr returns the MR/PR already open for the branch you are standing on", () =>
  withRepo('main', 'feat/x', async (repoDir) => {
    const { forge, branches } = lookupOnlyForge((branch) => (branch === 'feat/x' ? OPEN_MR : undefined));

    assert.deepEqual(await findFollowUpMr(forge, repoDir), OPEN_MR);
    assert.deepEqual(branches, ['feat/x']);
  }));

test('findFollowUpMr returns undefined when the branch has no open MR/PR, so the run opens a new one', () =>
  withRepo('main', 'feat/y', async (repoDir) => {
    const { forge } = lookupOnlyForge(() => undefined);
    assert.equal(await findFollowUpMr(forge, repoDir), undefined);
  }));

test('findFollowUpMr never asks the forge from a detached HEAD — there is no branch name to match', () =>
  withRepo('main', 'feat/x', async (repoDir) => {
    await execFileAsync('git', ['checkout', '-q', '--detach'], { cwd: repoDir });
    const { forge, branches } = lookupOnlyForge(() => OPEN_MR);

    assert.equal(await findFollowUpMr(forge, repoDir), undefined);
    assert.deepEqual(branches, []);
  }));
