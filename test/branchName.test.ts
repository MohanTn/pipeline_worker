import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBranchName } from '../src/git/branchName.js';

test('buildBranchName fills in the default pipeline-worker/{name} pattern', () => {
  assert.equal(buildBranchName('pipeline-worker/{name}', { type: 'feature', name: 'add-login-page' }), 'pipeline-worker/add-login-page');
});

test('buildBranchName composes a team pattern with type and ticket placeholders', () => {
  const branch = buildBranchName('{type}/{ticket}/{name}', { type: 'bugfix', ticket: 'PROJ-123', name: 'fix-login-redirect' });
  assert.equal(branch, 'bugfix/PROJ-123/fix-login-redirect');
});

test('buildBranchName throws a clear error when the pattern needs a ticket but none was supplied', () => {
  assert.throws(
    () => buildBranchName('{type}/{ticket}/{name}', { type: 'feature', name: 'add-login-page' }),
    /requires a ticket id/,
  );
});

test('buildBranchName ignores an unused ticket when the pattern has no {ticket} placeholder', () => {
  assert.equal(buildBranchName('pipeline-worker/{name}', { type: 'feature', ticket: 'PROJ-123', name: 'add-login-page' }), 'pipeline-worker/add-login-page');
});

test('buildBranchName rejects a composed name with unsafe characters', () => {
  assert.throws(() => buildBranchName('{name}', { type: 'feature', name: 'add login page' }), /not a valid git branch name/);
});

test('buildBranchName rejects a pattern that composes to an empty or malformed leading segment', () => {
  assert.throws(() => buildBranchName('/{name}', { type: 'feature', name: 'add-login-page' }), /not a valid git branch name/);
});
