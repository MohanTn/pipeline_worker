import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptBranch } from '../src/workflow/adoptBranch.js';
import { removeWorktree } from '../src/git/worktree.js';
import { loadRunState } from '../src/state/runState.js';
import type { ForgeClient } from '../src/forge/types.js';
import type { AgentAdapter } from '../src/agent/types.js';
import type { MergeRequest, PipelineWorkerConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);

function testConfig(): PipelineWorkerConfig {
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
  };
}

function stubForge(overrides: Partial<ForgeClient>): ForgeClient {
  return {
    findExistingMr: async () => undefined,
    createMergeRequest: async () => {
      throw new Error('not used');
    },
    updateMrDescription: async () => {
      throw new Error('not used');
    },
    getMrPipelines: async () => [],
    getFailedJobs: async () => [],
    getJobLog: async () => '',
    retryPipeline: async () => {
      throw new Error('not used');
    },
    createMrNote: async () => ({ id: 1 }),
    hasMergeConflicts: async () => false,
    ...overrides,
  };
}

const VALID_PAYLOAD = {
  intent: 'Let users export a report.',
  summary: 'Adds a CSV export button.',
  changeType: 'feature',
  branchSlug: 'add-csv-export',
  commitMessage: 'feat: add CSV export',
  fileChanges: [{ file: 'report.txt', summary: 'Adds a marker line.' }],
  risk: 'low',
  riskReason: 'Isolated, additive change.',
  testScenarios: ['Export a report and confirm the CSV downloads.'],
};

function stubAgent(): AgentAdapter {
  return { invoke: async () => ({ text: JSON.stringify(VALID_PAYLOAD) }) };
}

/** A repoRoot with an `origin` remote (bare) already holding `main`, mimicking a normal clone. */
async function makeRepoWithOrigin(): Promise<{ repoRoot: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-adopt-origin-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'pipeline-worker-adopt-repo-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'report.txt'), 'base\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoRoot });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repoRoot });
  return { repoRoot, originDir };
}

/** Pushes a hand-made branch to origin (simulating a user who never ran `pipeline-worker run`), leaving repoRoot back on main. */
async function pushHandMadeBranch(repoRoot: string, branch: string): Promise<void> {
  await execFileAsync('git', ['checkout', '-q', '-b', branch], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'report.txt'), 'base\nhand-pushed change\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'hand-pushed change'], { cwd: repoRoot });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', branch], { cwd: repoRoot });
  // `git worktree add` refuses a branch checked out elsewhere, including repoRoot's own working directory.
  await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
}

test('adoptBranch with no existing MR/PR: runs checks, captures intent, and opens a new MR/PR against the given target', async () => {
  const { repoRoot, originDir } = await makeRepoWithOrigin();
  const branch = 'hand-pushed/no-pr-yet';
  let worktreePath: string | undefined;
  try {
    await pushHandMadeBranch(repoRoot, branch);

    let createArgs: unknown;
    const forge = stubForge({
      findExistingMr: async () => undefined,
      createMergeRequest: async (args) => {
        createArgs = args;
        return { iid: 101, webUrl: 'http://example/pr/101', sourceBranch: args.sourceBranch, targetBranch: args.targetBranch, state: 'open' } as MergeRequest;
      },
    });

    const state = await adoptBranch(repoRoot, testConfig(), forge, stubAgent(), branch, 'main');
    worktreePath = state.worktreePath;

    assert.equal(state.mrIid, 101);
    assert.equal(state.phase, 'mr');
    assert.equal(state.targetBranch, 'main');
    assert.deepEqual(createArgs, {
      sourceBranch: branch,
      targetBranch: 'main',
      title: 'feat: add CSV export',
      description: (createArgs as { description: string }).description,
    });
    assert.match((createArgs as { description: string }).description, /Adds a CSV export button\./);

    const persisted = loadRunState(repoRoot, branch);
    assert.equal(persisted?.mrIid, 101);
  } finally {
    if (worktreePath) await removeWorktree(repoRoot, worktreePath);
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('adoptBranch with an existing MR/PR: skips local checks entirely and overwrites the description using the MR/PR\'s own target branch', async () => {
  const { repoRoot, originDir } = await makeRepoWithOrigin();
  const branch = 'hand-pushed/has-pr';
  let worktreePath: string | undefined;
  try {
    await pushHandMadeBranch(repoRoot, branch);

    const existingMr: MergeRequest = { iid: 55, webUrl: 'http://example/pr/55', sourceBranch: branch, targetBranch: 'main', state: 'open' };
    let updateCall: { mrIid: number; description: string } | undefined;
    const forge = stubForge({
      findExistingMr: async () => existingMr,
      updateMrDescription: async (mrIid, description) => {
        updateCall = { mrIid, description };
      },
    });

    // A build command that would fail if it ever ran — proves the "existing
    // MR" path never re-runs local checks (it must skip straight to
    // overwriting the description), since a run that did try to check would
    // abort with this failure instead of reaching updateMrDescription.
    const config = { ...testConfig(), build: 'node -e "process.exit(1)"' };

    // Deliberately pass a --target override that conflicts with the MR's
    // real target: it must be ignored in favor of existingMr.targetBranch.
    const state = await adoptBranch(repoRoot, config, forge, stubAgent(), branch, 'some-other-branch');
    worktreePath = state.worktreePath;

    assert.equal(state.mrIid, 55);
    assert.equal(state.phase, 'mr');
    assert.equal(state.targetBranch, 'main');
    assert.ok(updateCall);
    assert.equal(updateCall?.mrIid, 55);
    assert.match(updateCall!.description, /Adds a CSV export button\./);
    assert.match(updateCall!.description, /Not run locally for this update/);
  } finally {
    if (worktreePath) await removeWorktree(repoRoot, worktreePath);
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
