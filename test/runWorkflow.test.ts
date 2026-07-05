import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../src/workflow/orchestrate.js';

/**
 * Mirrors config.test.ts's env isolation: a real .env for this repo (loaded
 * whenever pipeline-worker runs on itself) would otherwise leak into these
 * assertions on the default forge.
 */
const ENV_PREFIX = 'PIPELINE_WORKER_';
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

// fallow-ignore-next-line complexity
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

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
    process.env.PIPELINE_WORKER_FORGE = 'github';
    // dir isn't a git repo, so runWorkflow still fails past the guard — on
    // capturing the diff — confirming the ticket check was skipped rather
    // than passed by other means.
    await assert.rejects(
      () => runWorkflow(dir, {}),
      (error: unknown) => error instanceof Error && !/requires a ticket id/.test(error.message),
    );
  }));
