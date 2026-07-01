import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRuns, type WorkflowRun } from '../src/forge/github.js';

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return { id: 1, status: 'completed', conclusion: 'success', html_url: 'http://example/run/1', ...overrides };
}

test('aggregateRuns returns undefined for no runs (poller keeps waiting)', () => {
  assert.equal(aggregateRuns([]), undefined);
});

test('aggregateRuns reports running while any run is incomplete, even if another already failed', () => {
  const agg = aggregateRuns([run({ id: 1, conclusion: 'failure' }), run({ id: 2, status: 'in_progress', conclusion: null })]);
  assert.equal(agg?.status, 'running');
});

test('aggregateRuns surfaces the failed run (its id feeds getFailedJobs)', () => {
  const agg = aggregateRuns([run({ id: 1 }), run({ id: 2, conclusion: 'timed_out', html_url: 'http://example/run/2' })]);
  assert.deepEqual(agg, { id: 2, status: 'failed', webUrl: 'http://example/run/2' });
});

test('aggregateRuns is success when all runs pass or are skipped', () => {
  const agg = aggregateRuns([run({ id: 1 }), run({ id: 2, conclusion: 'skipped' })]);
  assert.equal(agg?.status, 'success');
});

test('aggregateRuns is skipped when every run was skipped', () => {
  const agg = aggregateRuns([run({ id: 1, conclusion: 'skipped' }), run({ id: 2, conclusion: 'neutral' })]);
  assert.equal(agg?.status, 'skipped');
});

test('aggregateRuns maps cancelled to canceled when nothing failed', () => {
  const agg = aggregateRuns([run({ id: 1 }), run({ id: 2, conclusion: 'cancelled' })]);
  assert.equal(agg?.status, 'canceled');
});
