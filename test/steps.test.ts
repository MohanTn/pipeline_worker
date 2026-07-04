/** Tests for src/ui/steps.ts's noteSession — the rest of steps.ts is terminal-rendering glue exercised indirectly via the workflow tests. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteSession } from '../src/ui/steps.js';

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
  const lines = captureLogs(() => noteSession({ text: 'hi' }));
  assert.deepEqual(lines, []);
});

test('noteSession prints the session id and duration in seconds when both are present', () => {
  const lines = captureLogs(() => noteSession({ text: 'hi', sessionId: 'abc-123', durationMs: 4200 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agent session: abc-123/);
  assert.match(lines[0], /4\.2s/);
});

test('noteSession prints the session id alone when durationMs is missing', () => {
  const lines = captureLogs(() => noteSession({ text: 'hi', sessionId: 'abc-123' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agent session: abc-123/);
  assert.doesNotMatch(lines[0], /s\)?$/);
});
