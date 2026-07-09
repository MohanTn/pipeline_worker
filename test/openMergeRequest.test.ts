import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDescription, openMergeRequest } from '../src/workflow/openMergeRequest.js';
import type { CapturedIntent, CheckResult, MergeMethod, MergeRequest } from '../src/types.js';
import type { ForgeClient } from '../src/forge/types.js';

const execFileAsync = promisify(execFile);

const INTENT: CapturedIntent = {
  intent: 'Let users sign in.',
  summary: 'Adds a login page.',
  changeType: 'feature',
  branchSlug: 'add-login-page',
  commitMessage: 'feat: add login page',
  fileChanges: [
    { file: 'src/login.ts', summary: 'Adds the login form component.' },
    { file: 'src/routes.ts', summary: 'Registers the /login route.' },
  ],
  risk: 'low',
  riskReason: 'New, isolated component with no existing callers.',
  testScenarios: ['Submit valid credentials and confirm redirect to the dashboard.'],
};

const CHECKS: CheckResult[] = [
  { name: 'build', ok: true, stdout: '', stderr: '', durationMs: 1200 },
  { name: 'lint', ok: true, stdout: '', stderr: '', durationMs: 800 },
  { name: 'test', ok: true, stdout: '', stderr: '', durationMs: 5100 },
];

test('buildDescription renders Intent, Summary, File changes, Risk, Checks, and Test Scenarios sections', () => {
  const description = buildDescription(INTENT, 'claude', CHECKS);
  assert.match(description, /\*\*Intent:\*\* Let users sign in\./);
  assert.match(description, /\*\*Summary:\*\* Adds a login page\./);
  assert.match(description, /\*\*File changes:\*\*\n- `src\/login\.ts`: Adds the login form component\.\n- `src\/routes\.ts`: Registers the \/login route\./);
  assert.match(description, /\*\*Risk:\*\* Low — New, isolated component with no existing callers\./);
  assert.match(description, /\*\*Checks:\*\*\n- ✅ build \(1\.2s\)\n- ✅ lint \(0\.8s\)\n- ✅ test \(5\.1s\)/);
  assert.match(description, /\*\*Test Scenarios:\*\*\n- Submit valid credentials and confirm redirect to the dashboard\./);
  assert.match(description, /intent captured via \*\*claude\*\*/);
});

test('buildDescription marks a failed check with ❌', () => {
  const description = buildDescription(INTENT, 'claude', [{ name: 'build', ok: false, stdout: '', stderr: '', durationMs: 500 }]);
  assert.match(description, /\*\*Checks:\*\*\n- ❌ build \(0\.5s\)/);
});

test('buildDescription renders a placeholder instead of an empty list when no checks were run locally (resume\'s branch-adoption path refreshing an existing MR/PR)', () => {
  const description = buildDescription(INTENT, 'claude', []);
  assert.match(description, /\*\*Checks:\*\*\n_Not run locally for this update — see the CI pipeline below\._/);
});

/** A repo with an `origin` remote already holding `main` and `branch` pushed — enough for openMergeRequest's stage-10 push to succeed. */
async function makeRepoOnBranch(branch: string): Promise<{ worktreePath: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-openmr-origin-'));
  const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-openmr-repo-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: worktreePath });
  writeFileSync(join(worktreePath, 'file.txt'), 'base\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: worktreePath });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: worktreePath });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['checkout', '-q', '-b', branch], { cwd: worktreePath });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', branch], { cwd: worktreePath });
  return { worktreePath, originDir };
}

function mrForgeStub(overrides: Partial<ForgeClient>): ForgeClient {
  return {
    findExistingMr: async () => undefined,
    createMergeRequest: async (args) =>
      ({ iid: 1, webUrl: 'http://example/mr/1', sourceBranch: args.sourceBranch, targetBranch: args.targetBranch, state: 'open' }) as MergeRequest,
    updateMrDescription: async () => {},
    getMrPipelines: async () => [],
    getFailedJobs: async () => [],
    getJobLog: async () => '',
    retryPipeline: async () => {
      throw new Error('not used');
    },
    createMrNote: async () => ({ id: 1 }),
    hasMergeConflicts: async () => false,
    isMrMerged: async () => false,
    enableAutoMerge: async () => {
      throw new Error('not used');
    },
    ...overrides,
  };
}

test('openMergeRequest calls enableAutoMerge with the MR iid and mergeMethod when autoMergeOnGreen is true', async () => {
  const { worktreePath, originDir } = await makeRepoOnBranch('feature/auto-merge-on');
  try {
    let call: { mrIid: number; mergeMethod: MergeMethod } | undefined;
    const forge = mrForgeStub({
      enableAutoMerge: async (mrIid, mergeMethod) => {
        call = { mrIid, mergeMethod };
      },
    });

    const mr = await openMergeRequest(forge, worktreePath, 'feature/auto-merge-on', 'main', INTENT, 'claude', CHECKS, true, 'rebase');

    assert.equal(mr.iid, 1);
    assert.deepEqual(call, { mrIid: 1, mergeMethod: 'rebase' });
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('openMergeRequest never calls enableAutoMerge when autoMergeOnGreen is false', async () => {
  const { worktreePath, originDir } = await makeRepoOnBranch('feature/auto-merge-off');
  try {
    let called = false;
    const forge = mrForgeStub({
      enableAutoMerge: async () => {
        called = true;
      },
    });

    await openMergeRequest(forge, worktreePath, 'feature/auto-merge-off', 'main', INTENT, 'claude', CHECKS, false, 'squash');

    assert.equal(called, false);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('openMergeRequest swallows a rejecting enableAutoMerge — the MR is still returned normally', async () => {
  const { worktreePath, originDir } = await makeRepoOnBranch('feature/auto-merge-fails');
  try {
    const forge = mrForgeStub({
      enableAutoMerge: async () => {
        throw new Error('auto-merge is not enabled for this repository');
      },
    });

    const mr = await openMergeRequest(forge, worktreePath, 'feature/auto-merge-fails', 'main', INTENT, 'claude', CHECKS, true, 'squash');

    assert.equal(mr.iid, 1);
    assert.equal(mr.webUrl, 'http://example/mr/1');
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('openMergeRequest does not call enableAutoMerge when reusing an already-existing MR/PR', async () => {
  const { worktreePath, originDir } = await makeRepoOnBranch('feature/reuse-existing');
  try {
    let called = false;
    const existing: MergeRequest = { iid: 9, webUrl: 'http://example/mr/9', sourceBranch: 'feature/reuse-existing', targetBranch: 'main', state: 'open' };
    const forge = mrForgeStub({
      findExistingMr: async () => existing,
      enableAutoMerge: async () => {
        called = true;
      },
    });

    const mr = await openMergeRequest(forge, worktreePath, 'feature/reuse-existing', 'main', INTENT, 'claude', CHECKS, true, 'squash');

    assert.equal(mr.iid, 9);
    assert.equal(called, false);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});
