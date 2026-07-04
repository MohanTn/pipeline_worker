import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPreserveWorktreeOnInterrupt } from '../src/workflow/orchestrate.js';

test('shouldPreserveWorktreeOnInterrupt keeps the worktree once an MR/PR is open (resume needs it)', () => {
  assert.equal(shouldPreserveWorktreeOnInterrupt('mr'), true);
  assert.equal(shouldPreserveWorktreeOnInterrupt('watch'), true);
});

test('shouldPreserveWorktreeOnInterrupt removes the worktree before any MR/PR exists', () => {
  assert.equal(shouldPreserveWorktreeOnInterrupt('diff'), false);
  assert.equal(shouldPreserveWorktreeOnInterrupt('intent'), false);
  assert.equal(shouldPreserveWorktreeOnInterrupt('checks'), false);
});

test('shouldPreserveWorktreeOnInterrupt removes the worktree once the run reached a terminal phase', () => {
  assert.equal(shouldPreserveWorktreeOnInterrupt('done'), false);
  assert.equal(shouldPreserveWorktreeOnInterrupt('escalated'), false);
});
