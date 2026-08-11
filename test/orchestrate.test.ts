import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phaseReached, resumeHint, resolveTargetBranch, findFollowUpMr, recordMrOnState, runAndReportChecks } from '../src/workflow/orchestrate.js';
import { beginRun, setRenderer } from '../src/ui/steps.js';
import type { Renderer } from '../src/ui/renderer.js';
import type { ForgeClient } from '../src/forge/types.js';
import type { MergeRequest, PipelineWorkerConfig, RunState } from '../src/types.js';

const execFileAsync = promisify(execFile);

test('recordMrOnState stores the forge web url next to the iid, so sessions can link to it later', () => {
  const state: RunState = { branch: 'feat/x', targetBranch: 'main', worktreePath: '/tmp/wt', ciFixAttempt: 0, conflictAttempt: 0, phase: 'checks' };
  recordMrOnState(state, { iid: 12, webUrl: 'https://self-hosted.example/g/app/-/merge_requests/12', sourceBranch: 'feat/x', targetBranch: 'main', state: 'open' });
  assert.equal(state.mrIid, 12);
  assert.equal(state.mrUrl, 'https://self-hosted.example/g/app/-/merge_requests/12');
  assert.equal(state.phase, 'mr');
});

test('recordMrOnState clears the failed stage, so a state file that failed earlier no longer reads as stuck', () => {
  const state: RunState = { branch: 'feat/x', targetBranch: 'main', worktreePath: '/tmp/wt', ciFixAttempt: 0, conflictAttempt: 0, phase: 'commit', failedStage: 'mr' };
  recordMrOnState(state, { iid: 3, webUrl: 'https://example.test/mr/3', sourceBranch: 'feat/x', targetBranch: 'main', state: 'open' });
  assert.equal(state.failedStage, undefined);
});

test('phaseReached says a stage already ran when the stored phase is at or past it', () => {
  assert.equal(phaseReached('commit', 'checks'), true);
  assert.equal(phaseReached('commit', 'intent'), true);
  assert.equal(phaseReached('commit', 'commit'), true);
});

test('phaseReached says a stage still has to run when the stored phase is earlier — the resume entry point', () => {
  // A run that died committing stored phase 'intent': commit re-runs, everything before it does not.
  assert.equal(phaseReached('intent', 'commit'), false);
  assert.equal(phaseReached('intent', 'apply'), true);
  assert.equal(phaseReached('intent', 'checks'), true);
});

test('phaseReached treats both terminal phases as past every stage', () => {
  for (const target of ['apply', 'checks', 'intent', 'commit', 'mr'] as const) {
    assert.equal(phaseReached('done', target), true, `done vs ${target}`);
    assert.equal(phaseReached('escalated', target), true, `escalated vs ${target}`);
  }
});

test('resumeHint names the branch the user has to pass back', () => {
  assert.equal(
    resumeHint({ branch: 'feat/login', targetBranch: 'main', worktreePath: '/tmp/wt', ciFixAttempt: 0, conflictAttempt: 0, phase: 'commit' }),
    'resume with: pipeline-worker resume --branch feat/login',
  );
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
    createInlineComment: notUsed,
    hasMergeConflicts: notUsed,
    enableAutoMerge: notUsed,
    approveMr: notUsed,
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

/** Only createMrNote matters for these tests; every other call would be a bug in the code under test. */
function noteSpyForge(): { forge: ForgeClient; notes: Array<{ mrIid: number; body: string }> } {
  const notes: Array<{ mrIid: number; body: string }> = [];
  const notUsed = async (): Promise<never> => {
    throw new Error('not used');
  };
  const forge = {
    findExistingMr: notUsed,
    createMergeRequest: notUsed,
    updateMrDescription: notUsed,
    getMrDescription: notUsed,
    getMrPipelines: notUsed,
    getFailedJobs: notUsed,
    getJobLog: notUsed,
    retryPipeline: notUsed,
    createMrNote: async (mrIid: number, body: string) => {
      notes.push({ mrIid, body });
      return { id: 1 };
    },
    createInlineComment: notUsed,
    hasMergeConflicts: notUsed,
    enableAutoMerge: notUsed,
    approveMr: notUsed,
    isMrMerged: notUsed,
    getCiConfigPath: notUsed,
  } as unknown as ForgeClient;
  return { forge, notes };
}

/** Only build/lint/test/runLintAndTest matter for runAndReportChecks. */
function checksConfig(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
  return {
    build: 'false', // always exits 1, portable on Linux/macOS CI
    lint: '',
    test: '',
    runLintAndTest: false,
    ...overrides,
  } as PipelineWorkerConfig;
}

function checksState(): RunState {
  return { branch: 'feat/x', targetBranch: 'main', worktreePath: '/tmp/wt', ciFixAttempt: 0, conflictAttempt: 0, phase: 'apply' };
}

/**
 * runAndReportChecks sets process.exitCode = 1 on a failed check — correct
 * for the real CLI process, but every test below deliberately fails a check
 * in-process, so left alone it would leak a nonzero exit code into this
 * whole test file's run (node:test reports the file itself as failed even
 * though every assertion passed). Reset it after each such test.
 */
function resetExitCode(): void {
  process.exitCode = undefined;
}

/**
 * runAndReportChecks paints through ui/steps.ts's runStep/note/endRun, which
 * without a renderer set falls back to the real live-TTY dashboard renderer —
 * fine for a real run, but its ANSI/cursor-control output has caused this
 * suite's parallel test-runner workers to occasionally corrupt their IPC
 * back to the main process (mirrors runWorkflow.test.ts's captureSettle).
 * A plain no-op renderer keeps these tests to their own assertions.
 */
function withNoopRenderer<T>(fn: () => Promise<T>): Promise<T> {
  const renderer: Renderer = { onEvent: () => {}, log: () => {}, stop: () => {} };
  setRenderer(renderer);
  beginRun([], { title: 'test' });
  return fn().finally(() => setRenderer(undefined));
}

test('runAndReportChecks posts a failure notice on the already-open MR/PR when checks fail on a follow-up run', () =>
  withNoopRenderer(async () => {
    const { forge, notes } = noteSpyForge();
    const state = checksState();
    const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-checks-followup-'));
    try {
      const result = await runAndReportChecks(checksConfig(), worktreePath, state, worktreePath, undefined, { forge, mr: OPEN_MR });
      assert.equal(result, null);
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.mrIid, OPEN_MR.iid);
      assert.match(notes[0]?.body ?? '', /follow-up run failed \(checks stage\)/);
      assert.match(notes[0]?.body ?? '', /build failed/);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      resetExitCode();
    }
  }));

test('runAndReportChecks never touches the forge for a fresh (non-follow-up) run', () =>
  withNoopRenderer(async () => {
    const state = checksState();
    const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-checks-fresh-'));
    try {
      // No `followUp` argument passed — a forge call here would throw ("not used") were one wired in by mistake.
      const result = await runAndReportChecks(checksConfig(), worktreePath, state, worktreePath);
      assert.equal(result, null);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      resetExitCode();
    }
  }));

test('runAndReportChecks still fails the run cleanly when the failure notice itself is rejected by the forge', () =>
  withNoopRenderer(async () => {
    const state = checksState();
    const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-checks-noteFails-'));
    const forge = {
      createMrNote: async () => {
        throw new Error('forge unreachable');
      },
    } as unknown as ForgeClient;
    try {
      const result = await runAndReportChecks(checksConfig(), worktreePath, state, worktreePath, undefined, { forge, mr: OPEN_MR });
      assert.equal(result, null, 'a rejected failure notice must not itself throw or change the outcome');
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      resetExitCode();
    }
  }));
