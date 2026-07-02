import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollForNextAction } from '../src/workflow/watchPipeline.js';
import type { ForgeClient } from '../src/forge/types.js';

function stubForge(overrides: Partial<ForgeClient>): ForgeClient {
  return {
    findExistingMr: async () => undefined,
    createMergeRequest: async () => {
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
