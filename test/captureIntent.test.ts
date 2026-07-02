import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureIntent } from '../src/workflow/captureIntent.js';
import type { AgentAdapter } from '../src/agent/types.js';

function fakeAgent(text: string): AgentAdapter {
  return { invoke: async () => ({ text }) };
}

const VALID_PAYLOAD = {
  summary: 'Adds a login page.',
  branchName: 'pipeline-worker/add-login-page',
  commitMessage: 'feat: add login page',
};

test('captureIntent accepts a short single-line commitMessage', async () => {
  const intent = await captureIntent(fakeAgent(JSON.stringify(VALID_PAYLOAD)), 'diff', '/tmp');
  assert.equal(intent.commitMessage, 'feat: add login page');
});

test('captureIntent rejects a multi-line commitMessage', async () => {
  const payload = { ...VALID_PAYLOAD, commitMessage: 'fix: things\n\n- bullet one\n- bullet two' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), 'diff', '/tmp'), /single line/);
});

test('captureIntent rejects a commitMessage longer than 72 characters', async () => {
  const payload = { ...VALID_PAYLOAD, commitMessage: 'fix: '.padEnd(80, 'x') };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), 'diff', '/tmp'));
});
