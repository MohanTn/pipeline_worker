import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from '../src/workflow/runChecks.js';
import type { PipelineWorkerConfig } from '../src/types.js';

function configWith(checks: Pick<PipelineWorkerConfig, 'build' | 'lint' | 'test'>): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'gitlab',
    gitlab: { host: '', projectId: 0 },
    github: { repo: '' },
    maxFixAttempts: 5,
    pollIntervalSeconds: 15,
    ...checks,
  };
}

test('runChecks skips stages with an empty command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-checks-test-'));
  try {
    const results = await runChecks(configWith({ build: '', lint: '', test: 'node --version' }), dir);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'test');
    assert.equal(results[0].ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runChecks stops at the first failing stage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-checks-test-'));
  try {
    const results = await runChecks(configWith({ build: 'node -e process.exit(1)', lint: '', test: 'node --version' }), dir);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'build');
    assert.equal(results[0].ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
