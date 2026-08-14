import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFindings, findingKey, nextTurnNumber, unseenThreadIds, type ReviewTurnRecord } from '../src/review/selection.js';
import type { ReviewFinding } from '../src/review/types.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { file: 'app.ts', line: 1, severity: 'MAJOR', comment: '### Bad\n\nfix it', ...overrides };
}

function turn(overrides: Partial<ReviewTurnRecord> = {}): ReviewTurnRecord {
  return { turn: 1, at: '2026-01-01T00:00:00.000Z', posted: [], ignored: [], edited: [], threadIds: [], ...overrides };
}

test('findingKey is stable across re-wordings of whitespace but not of text', () => {
  assert.equal(findingKey(finding()), findingKey(finding({ comment: '###  Bad\n\n  fix it  ' })));
  assert.notEqual(findingKey(finding()), findingKey(finding({ comment: '### Bad\n\nfix it differently' })));
  assert.notEqual(findingKey(finding()), findingKey(finding({ line: 2 })), 'the same comment on another line is another comment');
});

test('nextTurnNumber counts from the highest recorded round, and reads an empty history as round 1', () => {
  assert.equal(nextTurnNumber([]), 1);
  assert.equal(nextTurnNumber([turn({ turn: 1 }), turn({ turn: 3 })]), 4);
});

test('classifyFindings marks what was posted as seen and what was unchecked as ignored', () => {
  const posted = finding();
  const unchecked = finding({ line: 2, comment: '### Other\n\nno' });
  const fresh = finding({ line: 3, comment: '### New\n\nno' });
  const candidates = classifyFindings(
    [posted, unchecked, fresh],
    [turn({ turn: 1, posted: [findingKey(posted)] }), turn({ turn: 2, ignored: [findingKey(unchecked)] })],
  );

  assert.deepEqual(candidates.map((candidate) => candidate.status), ['seen', 'ignored', 'new']);
  assert.deepEqual(candidates.map((candidate) => candidate.lastTurn), [1, 2, undefined]);
});

test('a finding both posted and later ignored stays seen, so it is never posted twice', () => {
  const both = finding();
  const candidates = classifyFindings([both], [turn({ turn: 1, posted: [findingKey(both)] }), turn({ turn: 2, ignored: [findingKey(both)] })]);
  assert.equal(candidates[0].status, 'seen');
});

test('unseenThreadIds returns only the threads no earlier round had recorded', () => {
  assert.deepEqual(unseenThreadIds(['a', 'b', 'c'], [turn({ threadIds: ['a'] }), turn({ turn: 2, threadIds: ['b'] })]), ['c']);
  assert.deepEqual(unseenThreadIds(['a'], []), ['a'], 'with no history every thread is new');
});
