import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks, parseCommand } from '../src/workflow/runChecks.js';
import type { PipelineWorkerConfig } from '../src/types.js';

function configWith(checks: Pick<PipelineWorkerConfig, 'build' | 'lint' | 'test'>, runLintAndTest = true): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'gitlab',
    gitlab: { host: '', projectId: 0 },
    github: { repo: '' },
    maxFixAttempts: 5,
    pollIntervalSeconds: 15,
    runLintAndTest,
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

test('runChecks skips lint and test (but still runs build) when runLintAndTest is false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-checks-test-'));
  try {
    const results = await runChecks(
      configWith({ build: 'node --version', lint: 'node -e process.exit(1)', test: 'node -e process.exit(1)' }, false),
      dir,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'build');
    assert.equal(results[0].ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCommand keeps a quoted argument together, e.g. a dotnet test filter', () => {
  assert.deepEqual(parseCommand('dotnet build'), ['dotnet', 'build']);
  assert.deepEqual(parseCommand('dotnet test --filter "Category=Unit"'), ['dotnet', 'test', '--filter', 'Category=Unit']);
  assert.deepEqual(parseCommand("dotnet test --filter 'Category=Unit'"), ['dotnet', 'test', '--filter', 'Category=Unit']);
});

test('parseCommand collapses repeated whitespace instead of producing empty tokens', () => {
  assert.deepEqual(parseCommand('dotnet   build'), ['dotnet', 'build']);
});

test('runChecks passes a quoted argument through to the process as one argv entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-checks-test-'));
  try {
    const results = await runChecks(
      configWith({ build: '', lint: '', test: 'node -e "console.log(process.argv[1])" "two words"' }),
      dir,
    );
    assert.equal(results[0].ok, true);
    assert.equal(results[0].stdout.trim(), 'two words');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
