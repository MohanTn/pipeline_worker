import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollForNextAction, hasCiConfig, runCiFixAttempt, tryResolveConflicts } from '../src/workflow/watchPipeline.js';
import type { ForgeClient } from '../src/forge/types.js';
import type { AgentAdapter } from '../src/agent/types.js';
import type { PipelineWorkerConfig, Pipeline, RunState } from '../src/types.js';

const execFileAsync = promisify(execFile);

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-watchpipeline-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stubForge(overrides: Partial<ForgeClient>): ForgeClient {
  return {
    findExistingMr: async () => undefined,
    createMergeRequest: async () => {
      throw new Error('not used');
    },
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
    getCiConfigPath: async () => undefined,
    ...overrides,
  };
}

test('pollForNextAction reports no-pipeline once the grace window elapses with zero pipelines seen', async () => {
  const forge = stubForge({ getMrPipelines: async () => [] });
  const outcome = await pollForNextAction(forge, 1, 5, undefined, 20);
  assert.deepEqual(outcome, { kind: 'no-pipeline' });
});

test('pollForNextAction returns a terminal pipeline immediately, without waiting out the no-pipeline grace window', async () => {
  const pipeline = { id: 7, status: 'success' as const, webUrl: 'http://example/7' };
  const forge = stubForge({ getMrPipelines: async () => [pipeline] });
  const outcome = await pollForNextAction(forge, 1, 5, undefined, 10_000);
  assert.deepEqual(outcome, { kind: 'pipeline', pipeline });
});

test('pollForNextAction never reports no-pipeline once a pipeline has already been confirmed for this MR', async () => {
  const pipeline = { id: 99, status: 'success' as const, webUrl: 'http://example/99' };
  let calls = 0;
  const forge = stubForge({
    getMrPipelines: async () => {
      calls += 1;
      return calls < 3 ? [] : [pipeline];
    },
  });
  // previousPipelineId=42 signals CI is already known to exist (e.g. mid fix-push retry);
  // several empty polls in a row must not be mistaken for "no CI configured".
  const outcome = await pollForNextAction(forge, 1, 5, 42, 10);
  assert.deepEqual(outcome, { kind: 'pipeline', pipeline });
  assert.equal(calls, 3);
});

test('pollForNextAction treats a GitLab "manual" pipeline as terminal, not stuck polling the full window', async () => {
  const pipeline = { id: 10, status: 'manual' as const, webUrl: 'http://example/10' };
  const forge = stubForge({ getMrPipelines: async () => [pipeline] });
  const outcome = await pollForNextAction(forge, 1, 5, undefined, 10_000);
  assert.deepEqual(outcome, { kind: 'pipeline', pipeline });
});

test('pollForNextAction treats a GitLab "scheduled" pipeline as terminal, not stuck polling the full window', async () => {
  const pipeline = { id: 11, status: 'scheduled' as const, webUrl: 'http://example/11' };
  const forge = stubForge({ getMrPipelines: async () => [pipeline] });
  const outcome = await pollForNextAction(forge, 1, 5, undefined, 10_000);
  assert.deepEqual(outcome, { kind: 'pipeline', pipeline });
});

test('pollForNextAction still reports a confirmed merge conflict before any no-pipeline grace check', async () => {
  const forge = stubForge({ getMrPipelines: async () => [], hasMergeConflicts: async () => true });
  const outcome = await pollForNextAction(forge, 1, 5, undefined, 10_000);
  assert.deepEqual(outcome, { kind: 'conflict' });
});

test('pollForNextAction never reports no-pipeline once any pipeline (even non-terminal) has appeared, even if it later goes missing again', async () => {
  const pipeline = { id: 3, status: 'success' as const, webUrl: 'http://example/3' };
  let calls = 0;
  const forge = stubForge({
    getMrPipelines: async () => {
      calls += 1;
      if (calls === 1) return [{ id: 3, status: 'running' as const, webUrl: 'http://example/3' }]; // CI confirmed to exist, but not terminal yet
      if (calls < 5) return []; // a flaky/empty API response afterwards must not be mistaken for "no CI"
      return [pipeline];
    },
  });
  const outcome = await pollForNextAction(forge, 1, 5, undefined, 10 /* grace window smaller than the empty streak below */);
  assert.deepEqual(outcome, { kind: 'pipeline', pipeline });
  assert.equal(calls, 5);
});

test('pollForNextAction never reports no-pipeline when ciConfigured=true, even once the grace window would otherwise have elapsed', async () => {
  let calls = 0;
  const pipeline = { id: 5, status: 'success' as const, webUrl: 'http://example/5' };
  const forge = stubForge({
    getMrPipelines: async () => {
      calls += 1;
      return calls < 4 ? [] : [pipeline]; // registers well past a 20ms grace window
    },
  });
  const outcome = await pollForNextAction(forge, 1, 5, undefined, 20, true);
  assert.deepEqual(outcome, { kind: 'pipeline', pipeline });
  assert.equal(calls, 4);
});

test('hasCiConfig(gitlab) is true only when .gitlab-ci.yml exists at the worktree root', () =>
  withTempDir(async (dir) => {
    const forge = stubForge({});
    assert.equal(await hasCiConfig(dir, forge, 'gitlab'), false);
    writeFileSync(join(dir, '.gitlab-ci.yml'), 'stages: []\n');
    assert.equal(await hasCiConfig(dir, forge, 'gitlab'), true);
  }));

test('hasCiConfig(github) is true only once .github/workflows contains a .yml/.yaml file', () =>
  withTempDir(async (dir) => {
    const forge = stubForge({});
    assert.equal(await hasCiConfig(dir, forge, 'github'), false);
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    assert.equal(await hasCiConfig(dir, forge, 'github'), false); // dir exists but is empty
    writeFileSync(join(dir, '.github', 'workflows', 'README.md'), '# not a workflow\n');
    assert.equal(await hasCiConfig(dir, forge, 'github'), false); // non-workflow file present, still no config
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yaml'), 'on: push\n');
    assert.equal(await hasCiConfig(dir, forge, 'github'), true);
  }));

test('hasCiConfig(gitlab) falls back to the forge\'s custom ci_config_path when .gitlab-ci.yml is absent', () =>
  withTempDir(async (dir) => {
    const forge = stubForge({ getCiConfigPath: async () => 'ci/custom.yml' });
    assert.equal(await hasCiConfig(dir, forge, 'gitlab'), false); // custom path doesn't exist in the worktree yet
    mkdirSync(join(dir, 'ci'), { recursive: true });
    writeFileSync(join(dir, 'ci', 'custom.yml'), 'stages: []\n');
    assert.equal(await hasCiConfig(dir, forge, 'gitlab'), true);
  }));

test('hasCiConfig(gitlab) treats a "path@group/project" external config reference as configured, with no local filesystem check', () =>
  withTempDir(async (dir) => {
    const forge = stubForge({ getCiConfigPath: async () => 'shared/ci.yml@group/other-project' });
    assert.equal(await hasCiConfig(dir, forge, 'gitlab'), true);
  }));

test('hasCiConfig(gitlab) stays false when getCiConfigPath resolves undefined and .gitlab-ci.yml is absent', () =>
  withTempDir(async (dir) => {
    const forge = stubForge({ getCiConfigPath: async () => undefined });
    assert.equal(await hasCiConfig(dir, forge, 'gitlab'), false);
  }));

// --- runCiFixAttempt / tryResolveConflicts: local-verification-loop tests ---

/**
 * A plain repo (not a real `git worktree`) with an `origin` remote already
 * holding `branch` — enough for runCiFixAttempt/tryResolveConflicts, which
 * only ever run git commands against `worktreePath`, never care whether it's
 * a literal worktree. `stateRoot` is a separate scratch directory to pass as
 * the `repoRoot` argument (recordEvent's target for .pipeline-worker/state/)
 * — it must never be worktreePath itself, or the state JSON file recordEvent
 * writes would land inside the git repo as an untracked file and pollute
 * every hasChanges() check the loop makes.
 */
async function makeRepoOnBranch(branch: string): Promise<{ worktreePath: string; originDir: string; stateRoot: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-fixloop-origin-'));
  const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-fixloop-repo-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'pipeline-worker-fixloop-state-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: worktreePath });
  writeFileSync(join(worktreePath, 'file.txt'), 'line1\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: worktreePath });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: worktreePath });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: worktreePath });
  if (branch !== 'main') {
    await execFileAsync('git', ['checkout', '-q', '-b', branch], { cwd: worktreePath });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', branch], { cwd: worktreePath });
  }
  return { worktreePath, originDir, stateRoot };
}

async function commitCountOn(dir: string, ref = 'HEAD'): Promise<number> {
  const { stdout } = await execFileAsync('git', ['rev-list', '--count', ref], { cwd: dir });
  return Number(stdout.trim());
}

function fixLoopConfig(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'github',
    gitlab: { host: '', projectId: 1 },
    github: { repo: 'acme/widgets' },
    // Only "build" runs (runLintAndTest: false) — passes once a file called FIXED exists in the worktree.
    build: 'node -e "process.exit(require(\'fs\').existsSync(\'FIXED\') ? 0 : 1)"',
    lint: '',
    test: '',
    maxFixAttempts: 5,
    pollIntervalSeconds: 15,
    intentModel: 'haiku',
    branchPattern: '{type}/{name}',
    cleanupOnSuccess: false,
    cleanupEarly: false,
    runLintAndTest: false,
    updateChangelog: false,
    ...overrides,
  };
}

function fixLoopState(branch: string): RunState {
  return { branch, targetBranch: 'main', worktreePath: '', ciFixAttempt: 0, conflictAttempt: 0, phase: 'watch' };
}

function fixLoopForge(overrides: Partial<ForgeClient> = {}): ForgeClient {
  return {
    findExistingMr: async () => undefined,
    createMergeRequest: async () => {
      throw new Error('not used');
    },
    updateMrDescription: async () => {},
    getMrPipelines: async () => [],
    getFailedJobs: async () => [],
    getJobLog: async () => '',
    retryPipeline: async () => {
      throw new Error('not used');
    },
    createMrNote: async () => ({ id: 1 }),
    hasMergeConflicts: async () => false,
    enableAutoMerge: async () => {
      throw new Error('not used');
    },
    getCiConfigPath: async () => undefined,
    ...overrides,
  };
}

const FAILED_PIPELINE: Pipeline = { id: 1, status: 'failed', webUrl: 'http://example/pipeline/1' };

test('runCiFixAttempt: fix passes local checks on the first try — 1 agent call, exactly 1 push, ciFixAttempt 1', async () => {
  const { worktreePath, originDir, stateRoot } = await makeRepoOnBranch('fix/one-shot');
  try {
    let calls = 0;
    const agent: AgentAdapter = {
      invoke: async (opts) => {
        calls += 1;
        writeFileSync(join(opts.cwd, 'FIXED'), 'x');
        return { text: 'fixed it' };
      },
    };
    const state = fixLoopState('fix/one-shot');
    state.worktreePath = worktreePath;
    const forge = fixLoopForge();

    const result = await runCiFixAttempt(forge, fixLoopConfig(), agent, worktreePath, 'fix/one-shot', 1, FAILED_PIPELINE, state, stateRoot);

    assert.equal(calls, 1);
    assert.deepEqual(result, { action: 'continue', previousPipelineId: 1 });
    assert.equal(state.ciFixAttempt, 1);
    assert.equal(await commitCountOn(worktreePath), 2); // init + 1 fix commit
    assert.equal(await commitCountOn(originDir, 'fix/one-shot'), 2); // pushed
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('runCiFixAttempt: fix fails locally once, passes on retry — 2 agent calls, exactly 1 push', async () => {
  const { worktreePath, originDir, stateRoot } = await makeRepoOnBranch('fix/retry-once');
  try {
    let calls = 0;
    const agent: AgentAdapter = {
      invoke: async (opts) => {
        calls += 1;
        if (calls === 1) {
          writeFileSync(join(opts.cwd, 'attempt1.txt'), 'partial fix');
        } else {
          writeFileSync(join(opts.cwd, 'FIXED'), 'x');
        }
        return { text: `attempt ${calls}` };
      },
    };
    const state = fixLoopState('fix/retry-once');
    state.worktreePath = worktreePath;
    const forge = fixLoopForge();

    const result = await runCiFixAttempt(forge, fixLoopConfig(), agent, worktreePath, 'fix/retry-once', 1, FAILED_PIPELINE, state, stateRoot);

    assert.equal(calls, 2);
    assert.deepEqual(result, { action: 'continue', previousPipelineId: 1 });
    assert.equal(state.ciFixAttempt, 2);
    assert.equal(await commitCountOn(worktreePath), 3); // init + 2 fix commits (one per iteration)
    assert.equal(await commitCountOn(originDir, 'fix/retry-once'), 3); // both local commits landed on origin via the single final push
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('runCiFixAttempt: never passes locally, budget exhausts — 0 pushes, escalation cites "still fails locally"', async () => {
  const { worktreePath, originDir, stateRoot } = await makeRepoOnBranch('fix/never');
  try {
    let calls = 0;
    const agent: AgentAdapter = {
      invoke: async (opts) => {
        calls += 1;
        writeFileSync(join(opts.cwd, `attempt${calls}.txt`), 'still broken');
        return { text: `attempt ${calls}` };
      },
    };
    const state = fixLoopState('fix/never');
    state.worktreePath = worktreePath;
    let noteBody = '';
    const forge = fixLoopForge({
      createMrNote: async (mrIid, body) => {
        noteBody = body;
        return { id: 1 };
      },
    });

    const result = await runCiFixAttempt(forge, fixLoopConfig({ maxFixAttempts: 2 }), agent, worktreePath, 'fix/never', 1, FAILED_PIPELINE, state, stateRoot);

    assert.deepEqual(result, { action: 'stop' });
    assert.equal(state.ciFixAttempt, 3); // 2 allowed + the one that trips the "exceeded" check
    assert.match(noteBody, /still fails locally/);
    assert.doesNotMatch(noteBody, /still failing — http/);
    assert.equal(await commitCountOn(originDir, 'fix/never'), 1); // nothing ever pushed
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('runCiFixAttempt: agent produces no changes — escalates without ever running local checks', async () => {
  const { worktreePath, originDir, stateRoot } = await makeRepoOnBranch('fix/no-op');
  try {
    const agent: AgentAdapter = { invoke: async () => ({ text: 'nothing to do' }) };
    const state = fixLoopState('fix/no-op');
    state.worktreePath = worktreePath;
    let noteBody = '';
    const forge = fixLoopForge({
      createMrNote: async (mrIid, body) => {
        noteBody = body;
        return { id: 1 };
      },
    });
    // A build command that would create a sentinel file if it ever ran — proves runChecks was never invoked.
    const config = fixLoopConfig({ build: `node -e "require('fs').writeFileSync('ran-build','x')"` });

    const result = await runCiFixAttempt(forge, config, agent, worktreePath, 'fix/no-op', 1, FAILED_PIPELINE, state, stateRoot);

    assert.deepEqual(result, { action: 'stop' });
    assert.match(noteBody, /produced no changes/);
    assert.throws(() => readFileSync(join(worktreePath, 'ran-build')));
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('tryResolveConflicts: clean merge, local check fails once, then passes — resolved without repeating the merge, exactly 1 push', async () => {
  const { worktreePath, originDir, stateRoot } = await makeRepoOnBranch('conflict/clean-merge-retry');
  try {
    // Advance origin/main with a change that doesn't textually conflict with the branch, so the merge is clean.
    const otherClone = mkdtempSync(join(tmpdir(), 'pipeline-worker-fixloop-other-'));
    await execFileAsync('git', ['clone', '-q', originDir, otherClone]);
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: otherClone });
    writeFileSync(join(otherClone, 'other.txt'), 'unrelated change\n');
    await execFileAsync('git', ['add', '-A'], { cwd: otherClone });
    await execFileAsync('git', ['commit', '-q', '-m', 'unrelated change on main'], { cwd: otherClone });
    await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: otherClone });
    rmSync(otherClone, { recursive: true, force: true });

    // The merge itself happens before the agent is ever invoked (see tryResolveConflicts),
    // so the local check fails exactly once on that first, agent-less iteration; the
    // agent's single call (loop-back iteration) fixes it immediately.
    let calls = 0;
    const agent: AgentAdapter = {
      invoke: async (opts) => {
        calls += 1;
        writeFileSync(join(opts.cwd, 'FIXED'), 'x');
        return { text: `attempt ${calls}` };
      },
    };
    const state = fixLoopState('conflict/clean-merge-retry');
    state.worktreePath = worktreePath;
    const forge = fixLoopForge();

    const resolved = await tryResolveConflicts(forge, agent, fixLoopConfig(), worktreePath, 'conflict/clean-merge-retry', 'main', 1, state, stateRoot);

    assert.equal(resolved, true);
    assert.equal(calls, 1); // the merge itself needed no agent help; only the post-merge local-check failure did
    assert.equal(state.conflictAttempt, 2);
    assert.equal(await commitCountOn(originDir, 'conflict/clean-merge-retry'), await commitCountOn(worktreePath)); // fully pushed, local and origin match
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('tryResolveConflicts: real conflict resolved by the agent, verified locally, pushed', async () => {
  const { worktreePath, originDir, stateRoot } = await makeRepoOnBranch('conflict/real');
  try {
    // Make the branch and origin/main edit the same line differently, so the merge produces real conflict markers.
    writeFileSync(join(worktreePath, 'file.txt'), 'line1-feature\n');
    await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
    await execFileAsync('git', ['commit', '-q', '-m', 'feature edit'], { cwd: worktreePath });
    await execFileAsync('git', ['push', '-q', 'origin', 'conflict/real'], { cwd: worktreePath });

    const otherClone = mkdtempSync(join(tmpdir(), 'pipeline-worker-fixloop-other-'));
    await execFileAsync('git', ['clone', '-q', originDir, otherClone]);
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: otherClone });
    writeFileSync(join(otherClone, 'file.txt'), 'line1-main\n');
    await execFileAsync('git', ['add', '-A'], { cwd: otherClone });
    await execFileAsync('git', ['commit', '-q', '-m', 'main edit'], { cwd: otherClone });
    await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: otherClone });
    rmSync(otherClone, { recursive: true, force: true });

    let calls = 0;
    const agent: AgentAdapter = {
      invoke: async (opts) => {
        calls += 1;
        // Resolve the conflict markers and make the local check pass in the same turn.
        writeFileSync(join(opts.cwd, 'file.txt'), 'line1-resolved\n');
        writeFileSync(join(opts.cwd, 'FIXED'), 'x');
        return { text: 'resolved' };
      },
    };
    const state = fixLoopState('conflict/real');
    state.worktreePath = worktreePath;
    const forge = fixLoopForge();

    const resolved = await tryResolveConflicts(forge, agent, fixLoopConfig(), worktreePath, 'conflict/real', 'main', 1, state, stateRoot);

    assert.equal(resolved, true);
    assert.equal(calls, 1);
    assert.equal(state.conflictAttempt, 1);
    assert.equal(readFileSync(join(worktreePath, 'file.txt'), 'utf-8'), 'line1-resolved\n');
    assert.equal(await commitCountOn(originDir, 'conflict/real'), 4); // init + feature edit + main edit + merge-resolution commit
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('tryResolveConflicts: merge resolves cleanly but local checks never pass — budget exhausts, escalation cites local checks', async () => {
  const { worktreePath, originDir, stateRoot } = await makeRepoOnBranch('conflict/never-fixed');
  try {
    const otherClone = mkdtempSync(join(tmpdir(), 'pipeline-worker-fixloop-other-'));
    await execFileAsync('git', ['clone', '-q', originDir, otherClone]);
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: otherClone });
    writeFileSync(join(otherClone, 'other.txt'), 'unrelated change\n');
    await execFileAsync('git', ['add', '-A'], { cwd: otherClone });
    await execFileAsync('git', ['commit', '-q', '-m', 'unrelated change on main'], { cwd: otherClone });
    await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: otherClone });
    rmSync(otherClone, { recursive: true, force: true });

    let calls = 0;
    const agent: AgentAdapter = {
      invoke: async (opts) => {
        calls += 1;
        writeFileSync(join(opts.cwd, `attempt${calls}.txt`), 'still broken');
        return { text: `attempt ${calls}` };
      },
    };
    const state = fixLoopState('conflict/never-fixed');
    state.worktreePath = worktreePath;
    let noteBody = '';
    const forge = fixLoopForge({
      createMrNote: async (mrIid, body) => {
        noteBody = body;
        return { id: 1 };
      },
    });

    const resolved = await tryResolveConflicts(forge, agent, fixLoopConfig({ maxFixAttempts: 2 }), worktreePath, 'conflict/never-fixed', 'main', 1, state, stateRoot);

    assert.equal(resolved, false);
    assert.equal(state.conflictAttempt, 3);
    assert.match(noteBody, /local checks still fail/);
    assert.equal(await commitCountOn(originDir, 'conflict/never-fixed'), 1); // nothing was ever pushed — the clean merge only committed locally
    assert.ok((await commitCountOn(worktreePath)) > 1); // but the merge did land locally, proving it wasn't retried from scratch each iteration
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
