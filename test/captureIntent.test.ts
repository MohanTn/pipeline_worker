import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureIntent } from '../src/workflow/captureIntent.js';
import type { AgentAdapter } from '../src/agent/types.js';

function fakeAgent(text: string): AgentAdapter {
  return { invoke: async () => ({ text }) };
}

const VALID_PAYLOAD = {
  intent: 'Let users sign in.',
  summary: 'Adds a login page.',
  branchName: 'pipeline-worker/add-login-page',
  commitMessage: 'feat: add login page',
  fileChanges: [{ file: 'src/login.ts', summary: 'Adds the login form component.' }],
  risk: 'low',
  riskReason: 'New, isolated component with no existing callers.',
  testScenarios: ['Submit valid credentials and confirm redirect to the dashboard.'],
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

test('captureIntent rejects an invalid risk level', async () => {
  const payload = { ...VALID_PAYLOAD, risk: 'critical' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), 'diff', '/tmp'));
});

test('captureIntent rejects empty fileChanges or testScenarios', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, fileChanges: [] })), 'diff', '/tmp'));
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, testScenarios: [] })), 'diff', '/tmp'));
});

test('captureIntent rejects multi-line values in fields rendered as a single line', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, intent: 'line one\nline two' })), 'diff', '/tmp'), /single line/);
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, riskReason: 'line one\nline two' })), 'diff', '/tmp'), /single line/);
  await assert.rejects(
    captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, testScenarios: ['line one\nline two'] })), 'diff', '/tmp'),
    /single line/,
  );
  await assert.rejects(
    captureIntent(
      fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, fileChanges: [{ file: 'a.ts', summary: 'line one\nline two' }] })),
      'diff',
      '/tmp',
    ),
    /single line/,
  );
});
