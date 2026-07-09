/**
 * Regression guard on the step skeletons: shared workflow helpers
 * (runAndReportChecks, maybeUpdateChangelog, openMergeRequest, watchPipeline,
 * maybeSyncTargetBranch) reference the ids 'checks', 'changelog', 'push',
 * 'mr', 'ci-watch', and 'merge' directly — a skeleton missing one of them
 * would silently materialize it as a stray top-level node instead of in its
 * intended position, which is exactly the kind of drift a data-only change
 * to runPlan.ts could introduce unnoticed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshRunSkeleton, resumeSkeleton, adoptSkeleton } from '../src/workflow/runPlan.js';

function ids(skeleton: ReturnType<typeof freshRunSkeleton>): string[] {
  return skeleton.map((s) => s.id);
}

test('freshRunSkeleton declares every id the shared workflow helpers rely on, in run order', () => {
  const skeleton = ids(freshRunSkeleton('main', 'claude'));
  for (const required of ['capture', 'worktree', 'intent', 'checks', 'changelog', 'commit', 'push', 'mr', 'ci-watch', 'merge']) {
    assert.ok(skeleton.includes(required), `missing step id: ${required}`);
  }
  assert.ok(skeleton.indexOf('checks') < skeleton.indexOf('mr'));
  assert.ok(skeleton.indexOf('mr') < skeleton.indexOf('ci-watch'));
  assert.ok(skeleton.indexOf('ci-watch') < skeleton.indexOf('merge'));
});

test('resumeSkeleton declares ci-watch before any escalate() can fire during a resumed watch loop', () => {
  const skeleton = ids(resumeSkeleton('main'));
  assert.deepEqual(skeleton, ['resume', 'ci-watch', 'merge']);
});

test('adoptSkeleton declares ci-watch (and the checks/mr ids adoptWithoutMr reuses) before watchPipeline can run', () => {
  const skeleton = ids(adoptSkeleton('feature/hand-pushed'));
  for (const required of ['adopt', 'inspect', 'checks', 'intent', 'mr', 'ci-watch', 'merge']) {
    assert.ok(skeleton.includes(required), `missing step id: ${required}`);
  }
  assert.ok(skeleton.indexOf('mr') < skeleton.indexOf('ci-watch'));
});

test('every skeleton has unique ids — a duplicate would make RunTree.add() silently no-op on the second occurrence', () => {
  for (const skeleton of [freshRunSkeleton('main', 'claude'), resumeSkeleton('main'), adoptSkeleton('feature/x')]) {
    const seen = ids(skeleton);
    assert.equal(new Set(seen).size, seen.length);
  }
});
