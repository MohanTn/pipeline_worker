import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncTargetBranchAfterMerge, maybeSyncTargetBranch, type SyncTiming } from '../src/workflow/syncTargetBranch.js';
import type { ForgeClient } from '../src/forge/types.js';
import type { PipelineWorkerConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);

/** Fast enough that the polling/settle delays don't slow the suite down. */
const FAST: SyncTiming = { pollMs: 5, timeoutMs: 250, settleMs: 1 };
/** Expires after ~2 polls, for the never-merges cases. */
const EXPIRING: SyncTiming = { pollMs: 5, timeoutMs: 12, settleMs: 1 };

function stubForge(overrides: Partial<ForgeClient>): ForgeClient {
  const notUsed = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    findExistingMr: notUsed,
    createMergeRequest: notUsed,
    updateMrDescription: notUsed,
    getMrPipelines: notUsed,
    getFailedJobs: notUsed,
    getJobLog: notUsed,
    retryPipeline: notUsed,
    createMrNote: notUsed,
    hasMergeConflicts: notUsed,
    isMrMerged: notUsed,
    enableAutoMerge: notUsed,
    getCiConfigPath: notUsed,
    ...overrides,
  };
}

function testConfig(autoMergeOnGreen: boolean): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'github',
    gitlab: { host: '', projectId: 1 },
    github: { repo: 'acme/widgets' },
    build: '',
    lint: '',
    test: '',
    maxFixAttempts: 3,
    pollIntervalSeconds: 30,
    intentModel: 'haiku',
    branchPattern: '{type}/{name}',
    cleanupOnSuccess: false,
    cleanupEarly: false,
    runLintAndTest: false,
    updateChangelog: false,
    autoMergeOnGreen,
    mergeMethod: 'squash',
    squashOnMerge: false,
  };
}

/**
 * A local repo checked out on main whose origin/main is one commit ahead —
 * exactly the state the forge's auto-merge leaves behind: the merged result
 * exists on origin, the user's local main hasn't seen it yet.
 */
async function makeRepoBehindOrigin(): Promise<{ repoRoot: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-sync-origin-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'pipeline-worker-sync-repo-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'file.txt'), 'base\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoRoot });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repoRoot });

  // The "auto-merged MR": land one more commit on origin/main, then rewind
  // the local main so it hasn't seen it.
  writeFileSync(join(repoRoot, 'file.txt'), 'base\nmerged change\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'feat: the merged MR'], { cwd: repoRoot });
  await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: repoRoot });

  return { repoRoot, originDir };
}

async function headSubject(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd: repoRoot });
  return stdout.trim();
}

function cleanup(repoRoot: string, originDir: string): void {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(originDir, { recursive: true, force: true });
}

test('syncTargetBranchAfterMerge fast-forwards the local target branch once the forge confirms the merge', async () => {
  const { repoRoot, originDir } = await makeRepoBehindOrigin();
  try {
    const forge = stubForge({ isMrMerged: async () => true });
    const outcome = await syncTargetBranchAfterMerge(forge, repoRoot, 'main', 1, FAST);
    assert.equal(outcome, 'updated');
    assert.equal(await headSubject(repoRoot), 'feat: the merged MR');
  } finally {
    cleanup(repoRoot, originDir);
  }
});

test('syncTargetBranchAfterMerge keeps polling while the forge still reports the MR/PR unmerged', async () => {
  const { repoRoot, originDir } = await makeRepoBehindOrigin();
  try {
    let calls = 0;
    const forge = stubForge({ isMrMerged: async () => ++calls >= 3 });
    const outcome = await syncTargetBranchAfterMerge(forge, repoRoot, 'main', 1, FAST);
    assert.equal(outcome, 'updated');
    assert.equal(calls, 3);
  } finally {
    cleanup(repoRoot, originDir);
  }
});

test('syncTargetBranchAfterMerge gives up (leaving the local branch untouched) when the merge never lands within the window', async () => {
  const { repoRoot, originDir } = await makeRepoBehindOrigin();
  try {
    const forge = stubForge({ isMrMerged: async () => false });
    const outcome = await syncTargetBranchAfterMerge(forge, repoRoot, 'main', 1, EXPIRING);
    assert.equal(outcome, 'merge-timeout');
    assert.equal(await headSubject(repoRoot), 'init');
  } finally {
    cleanup(repoRoot, originDir);
  }
});

test('syncTargetBranchAfterMerge skips when the repo was switched off the target branch mid-run', async () => {
  const { repoRoot, originDir } = await makeRepoBehindOrigin();
  try {
    await execFileAsync('git', ['checkout', '-q', '-b', 'unrelated-work'], { cwd: repoRoot });
    const forge = stubForge({ isMrMerged: async () => true });
    const outcome = await syncTargetBranchAfterMerge(forge, repoRoot, 'main', 1, FAST);
    assert.equal(outcome, 'not-on-target-branch');
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s', 'main'], { cwd: repoRoot });
    assert.equal(stdout.trim(), 'init'); // local main ref untouched
  } finally {
    cleanup(repoRoot, originDir);
  }
});

test('maybeSyncTargetBranch never contacts the forge when autoMergeOnGreen is disabled', async () => {
  let asked = false;
  const forge = stubForge({
    isMrMerged: async () => {
      asked = true;
      return true;
    },
  });
  await maybeSyncTargetBranch(forge, testConfig(false), '/nonexistent', 'main', 1, FAST);
  assert.equal(asked, false);
});

test('maybeSyncTargetBranch is best-effort: a diverged local target branch (ff-only refuses) never throws', async () => {
  const { repoRoot, originDir } = await makeRepoBehindOrigin();
  try {
    // Diverge local main from origin/main so --ff-only must refuse.
    writeFileSync(join(repoRoot, 'file.txt'), 'base\nlocal divergence\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'local: diverged'], { cwd: repoRoot });

    const forge = stubForge({ isMrMerged: async () => true });
    await maybeSyncTargetBranch(forge, testConfig(true), repoRoot, 'main', 1, FAST);
    assert.equal(await headSubject(repoRoot), 'local: diverged'); // local work preserved
  } finally {
    cleanup(repoRoot, originDir);
  }
});

test('maybeSyncTargetBranch runs the sync end-to-end when autoMergeOnGreen is enabled', async () => {
  const { repoRoot, originDir } = await makeRepoBehindOrigin();
  try {
    const forge = stubForge({ isMrMerged: async () => true });
    await maybeSyncTargetBranch(forge, testConfig(true), repoRoot, 'main', 1, FAST);
    assert.equal(await headSubject(repoRoot), 'feat: the merged MR');
  } finally {
    cleanup(repoRoot, originDir);
  }
});
