import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../src/workflow/orchestrate.js';

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
