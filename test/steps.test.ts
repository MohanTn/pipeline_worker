/** Tests for src/ui/steps.ts's noteSession, renderer selection, and the facade's never-throw contract. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteSession, truncateToWidth, selectRendererMode, beginRun, runStep, addDynamicStep, finishStep, endRun } from '../src/ui/steps.js';

function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test('noteSession prints nothing when the adapter returned no sessionId', () => {
  const lines = captureLogs(() => noteSession({ text: 'hi' }, '/tmp/worktree'));
  assert.deepEqual(lines, []);
});

test('noteSession prints the session id and duration in seconds when both are present', () => {
  const lines = captureLogs(() => noteSession({ text: 'hi', sessionId: 'abc-123', durationMs: 4200 }, '/tmp/worktree'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agent session: abc-123/);
  assert.match(lines[0], /4\.2s/);
});

test('noteSession omits the duration when durationMs is missing', () => {
  const lines = captureLogs(() => noteSession({ text: 'hi', sessionId: 'abc-123' }, '/tmp/worktree'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agent session: abc-123/);
  assert.doesNotMatch(lines[0], /\d+\.\ds/);
});

test('noteSession prints the worktree path to cd into for resuming', () => {
  const lines = captureLogs(() => noteSession({ text: 'hi', sessionId: 'abc-123' }, '/tmp/pipeline-worker-xyz/worktree'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cd \/tmp\/pipeline-worker-xyz\/worktree to resume it there/);
});

test('truncateToWidth leaves text at or under the given width untouched', () => {
  assert.equal(truncateToWidth('short line', 80), 'short line');
  assert.equal(truncateToWidth('exact', 5), 'exact');
});

test('truncateToWidth shortens text over width and appends an ellipsis, without exceeding width', () => {
  const result = truncateToWidth('a very long spinner detail line that would wrap', 20);
  assert.equal(result.length, 20);
  assert.equal(result, 'a very long spinner…');
});

test('truncateToWidth handles a width of 1 and non-positive widths without throwing', () => {
  assert.equal(truncateToWidth('hello', 1), 'h');
  assert.equal(truncateToWidth('hello', 0), 'hello');
  assert.equal(truncateToWidth('hello', -5), 'hello');
});

test('selectRendererMode picks the append-only LineRenderer off a non-TTY stream regardless of the plain-output env', () => {
  assert.equal(selectRendererMode(false, undefined), 'line');
  assert.equal(selectRendererMode(false, 'false'), 'line');
});

test('selectRendererMode picks the live TreeRenderer on a TTY unless PIPELINE_WORKER_PLAIN_OUTPUT opts out', () => {
  assert.equal(selectRendererMode(true, undefined), 'tree');
  assert.equal(selectRendererMode(true, 'false'), 'tree');
  assert.equal(selectRendererMode(true, 'true'), 'line');
  assert.equal(selectRendererMode(true, '1'), 'line');
  assert.equal(selectRendererMode(true, 'TRUE'), 'line');
});

test('runStep on an id absent from the skeleton still runs its task to completion instead of throwing', async () => {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => captured.push(args.join(' '));
  try {
    beginRun([{ id: 'capture', label: 'capture', detail: '' }], { title: 'test-run' });
    const result = await runStep('never-declared-in-skeleton', 'doing unexpected work', async () => 'task ran');
    assert.equal(result, 'task ran');
    assert.ok(captured.some((l) => l.includes('never-declared-in-skeleton')));
    endRun('done');
  } finally {
    console.log = orig;
  }
});

test('an escalated run marks the owning child and its ci-watch parent failed, visible in the narration', async () => {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => captured.push(args.join(' '));
  try {
    beginRun(
      [
        { id: 'ci-watch', label: 'ci-watch', detail: 'watch CI' },
        { id: 'merge', label: 'merge', detail: 'auto-merge + sync' },
      ],
      { title: 'test-run' },
    );
    addDynamicStep('ci-watch', 'ci-watch/fix-1', 'fix 1');
    await runStep('ci-watch/fix-1', 'exhausted fix attempts', async () => {
      throw new Error('budget exhausted');
    }).catch(() => undefined);
    finishStep('ci-watch', 'failed', { detail: 'escalated to a human — see the MR/PR comment' });
    endRun('escalated', 'see the MR/PR comment for what was tried and why');

    assert.ok(captured.some((l) => l.includes('✗') && l.includes('ci-watch') && l.includes('escalated to a human')));
    assert.ok(captured.some((l) => l.includes('Stopped for human review')));
    // 'merge' never started — it stays pending and prints no finish line of its own.
    assert.ok(!captured.some((l) => l.includes('✓ merge') || l.includes('✗ merge')));
  } finally {
    console.log = orig;
  }
});
