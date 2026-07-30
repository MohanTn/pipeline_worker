import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow, settleCancelledRun } from '../src/workflow/orchestrate.js';
import { beginRun, setRenderer } from '../src/ui/steps.js';
import type { Renderer } from '../src/ui/renderer.js';
import type { RunPhase, RunState } from '../src/types.js';

/**
 * Mirrors config.test.ts's isolation: runWorkflow calls loadConfig, which
 * reads (and, on first run, creates) $XDG_CONFIG_HOME/pipeline-worker/config.json
 * — point that at a throwaway directory so the real ~/.config never decides
 * what these assertions see.
 */
let configHome: string;
let savedConfigHome: string | undefined;

beforeEach(() => {
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = mkdtempSync(join(tmpdir(), 'pipeline-worker-confighome-'));
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

/** Writes the settings file loadConfig will read for this test. */
function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(configHome, 'pipeline-worker'), { recursive: true });
  writeFileSync(join(configHome, 'pipeline-worker', 'config.json'), JSON.stringify(settings), 'utf-8');
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-runworkflow-test-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/**
 * The cancel path settles the run display, so these drive it through a fake
 * Renderer (the seam ui/steps.ts already exposes for the TUI's own dashboard)
 * and read the state file back off disk. Cancellation itself is covered in
 * cancelScope.test.ts; what matters here is the policy applied when a
 * cancelled run lands in runWorkflow's catch.
 */
interface Settled {
  status: string;
  detail: string | undefined;
}

function captureSettle(): { settled: Settled[]; restore: () => void } {
  const settled: Settled[] = [];
  const renderer: Renderer = {
    onEvent: () => {},
    log: () => {},
    stop: (status, detail) => {
      settled.push({ status, detail });
    },
  };
  setRenderer(renderer);
  beginRun([], { title: 'run' });
  return { settled, restore: () => setRenderer(undefined) };
}

function stateInPhase(phase: RunPhase): RunState {
  return { branch: 'pipeline-worker/add-login', targetBranch: 'main', worktreePath: '/tmp/nonexistent-worktree', ciFixAttempt: 0, conflictAttempt: 0, phase };
}

test('a run cancelled once its MR/PR exists keeps the worktree and prints the resume command', () =>
  withTempDir(async (dir) => {
    const { settled, restore } = captureSettle();
    let markedDone = 0;
    try {
      settleCancelledRun(dir, stateInPhase('watch'), () => {
        markedDone += 1;
      });
    } finally {
      restore();
    }
    assert.deepEqual(settled, [{ status: 'interrupted', detail: 'resume with: pipeline-worker resume --branch pipeline-worker/add-login' }]);
    assert.equal(markedDone, 1, 'the worktree must be preserved for `resume` by satisfying the cleanup without running it');
  }));

test('a run cancelled before an MR/PR exists also keeps its worktree — that stage is resumable too', () =>
  withTempDir(async (dir) => {
    const { settled, restore } = captureSettle();
    let markedDone = 0;
    try {
      settleCancelledRun(dir, stateInPhase('checks'), () => {
        markedDone += 1;
      });
    } finally {
      restore();
    }
    assert.deepEqual(settled, [{ status: 'interrupted', detail: 'resume with: pipeline-worker resume --branch pipeline-worker/add-login' }]);
    assert.equal(markedDone, 1, 'the worktree holds the applied diff the next resume re-enters');
  }));

test('a cancelled run records the stage it stopped in, so resume knows where to pick up', () =>
  withTempDir(async (dir) => {
    const { restore } = captureSettle();
    try {
      settleCancelledRun(dir, stateInPhase('commit'), () => {});
    } finally {
      restore();
    }
    const path = join(dir, '.pipeline-worker', 'state', 'pipeline-worker_add-login.json');
    const state = JSON.parse(readFileSync(path, 'utf-8')) as RunState;
    assert.equal(state.failedStage, 'commit');
  }));

test('a cancelled run is narrated in its session history, so `sessions` shows why it stopped', () =>
  withTempDir(async (dir) => {
    const { restore } = captureSettle();
    try {
      settleCancelledRun(dir, stateInPhase('watch'), () => {});
    } finally {
      restore();
    }
    const path = join(dir, '.pipeline-worker', 'state', 'pipeline-worker_add-login.json');
    const state = JSON.parse(readFileSync(path, 'utf-8')) as RunState;
    const last = (state.history ?? []).at(-1);
    assert.equal(last?.message, 'Run cancelled from the TUI');
    assert.equal(last?.level, 'error');
  }));

test('runWorkflow rejects immediately when forge is gitlab (the default) and no --ticket is passed', () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => runWorkflow(dir, {}), /forge is gitlab, which requires a ticket id/);
  }));

test('runWorkflow does not raise the ticket error when forge is github', () =>
  withTempDir(async (dir) => {
    writeSettings({ forge: 'github' });
    // dir isn't a git repo, so runWorkflow still fails past the guard — on
    // capturing the diff — confirming the ticket check was skipped rather
    // than passed by other means.
    await assert.rejects(
      () => runWorkflow(dir, {}),
      (error: unknown) => error instanceof Error && !/requires a ticket id/.test(error.message),
    );
  }));
