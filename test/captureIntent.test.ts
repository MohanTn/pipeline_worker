import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureIntent } from '../src/workflow/captureIntent.js';
import type { AgentAdapter, AgentInvokeOptions } from '../src/agent/types.js';

function fakeAgent(text: string): AgentAdapter {
  return { invoke: async () => ({ text }) };
}

/** Captures the exact options captureIntent passed to the agent, for asserting on the prompt/tool scoping. */
function spyAgent(text: string): { agent: AgentAdapter; lastInvoke: () => AgentInvokeOptions } {
  let captured: AgentInvokeOptions | undefined;
  return {
    agent: {
      invoke: async (opts) => {
        captured = opts;
        return { text };
      },
    },
    lastInvoke: () => {
      if (!captured) throw new Error('agent.invoke was never called');
      return captured;
    },
  };
}

const VALID_PAYLOAD = {
  intent: 'Let users sign in.',
  summary: 'Adds a login page.',
  changeType: 'feature',
  branchSlug: 'add-login-page',
  commitMessage: 'feat: add login page',
  fileChanges: [{ file: 'src/login.ts', summary: 'Adds the login form component.' }],
  risk: 'low',
  riskReason: 'New, isolated component with no existing callers.',
  testScenarios: ['Submit valid credentials and confirm redirect to the dashboard.'],
};

test('captureIntent lists changed files in the prompt instead of embedding a diff, and scopes the agent to read-only tools', async () => {
  const { agent, lastInvoke } = spyAgent(JSON.stringify(VALID_PAYLOAD));
  await captureIntent(agent, ['src/login.ts', 'src/new-file.ts'], '/repo/worktree');

  const opts = lastInvoke();
  assert.match(opts.prompt, /- src\/login\.ts/);
  assert.match(opts.prompt, /- src\/new-file\.ts/);
  assert.doesNotMatch(opts.prompt, /```diff/);
  assert.equal(opts.cwd, '/repo/worktree');
  assert.equal(opts.permissionMode, 'default');
  assert.deepEqual(opts.allowedTools, ['Read', 'Grep', 'Glob', 'Bash(git diff:*)']);
});

test('captureIntent accepts a short single-line commitMessage', async () => {
  const intent = await captureIntent(fakeAgent(JSON.stringify(VALID_PAYLOAD)), ['src/login.ts'], '/tmp');
  assert.equal(intent.commitMessage, 'feat: add login page');
});

test('captureIntent rejects a multi-line commitMessage', async () => {
  const payload = { ...VALID_PAYLOAD, commitMessage: 'fix: things\n\n- bullet one\n- bullet two' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp'), /single line/);
});

test('captureIntent rejects a commitMessage longer than 72 characters', async () => {
  const payload = { ...VALID_PAYLOAD, commitMessage: 'fix: '.padEnd(80, 'x') };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp'));
});

test('captureIntent rejects an invalid risk level', async () => {
  const payload = { ...VALID_PAYLOAD, risk: 'critical' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp'));
});

test('captureIntent rejects an invalid changeType', async () => {
  const payload = { ...VALID_PAYLOAD, changeType: 'refactor' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp'));
});

test('captureIntent rejects a branchSlug with a prefix or uppercase characters', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, branchSlug: 'pipeline-worker/add-login-page' })), ['src/login.ts'], '/tmp'));
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, branchSlug: 'Add-Login-Page' })), ['src/login.ts'], '/tmp'));
});

test('captureIntent rejects empty fileChanges or testScenarios', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, fileChanges: [] })), ['src/login.ts'], '/tmp'));
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, testScenarios: [] })), ['src/login.ts'], '/tmp'));
});

test('captureIntent rejects multi-line values in fields rendered as a single line', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, intent: 'line one\nline two' })), ['src/login.ts'], '/tmp'), /single line/);
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, riskReason: 'line one\nline two' })), ['src/login.ts'], '/tmp'), /single line/);
  await assert.rejects(
    captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, testScenarios: ['line one\nline two'] })), ['src/login.ts'], '/tmp'),
    /single line/,
  );
  await assert.rejects(
    captureIntent(
      fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, fileChanges: [{ file: 'a.ts', summary: 'line one\nline two' }] })),
      ['src/login.ts'],
      '/tmp',
    ),
    /single line/,
  );
});
