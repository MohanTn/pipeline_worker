import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIntent, filesMissingFromDiff } from '../src/workflow/captureIntent.js';
import type { AgentAdapter, AgentInvokeOptions } from '../src/agent/types.js';

const execFileAsync = promisify(execFile);

/**
 * A real repo with one committed file, then an uncommitted edit to it plus an
 * untracked file — the exact shape a fresh run's worktree has when
 * captureIntent runs (see orchestrate.ts: the diff is applied but not yet
 * committed, so `git diff HEAD` is what shows it).
 */
async function makeWorktreeWithChange(): Promise<{ dir: string; headSha: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-intent-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: dir });
  writeFileSync(join(dir, 'login.ts'), 'export const timeout = 30;\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });

  writeFileSync(join(dir, 'login.ts'), 'export const timeout = 90;\n');
  writeFileSync(join(dir, 'new-file.ts'), 'export const brandNew = true;\n');
  return { dir, headSha: stdout.trim(), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

test('captureIntent embeds the real git diff, so the agent judges the delta rather than the changed file\'s new state', async () => {
  const repo = await makeWorktreeWithChange();
  try {
    const { agent, lastInvoke } = spyAgent(JSON.stringify(VALID_PAYLOAD));
    await captureIntent(agent, ['login.ts', 'new-file.ts'], repo.dir, 'haiku');

    const opts = lastInvoke();
    assert.match(opts.prompt, /--- begin diff ---/);
    assert.match(opts.prompt, /^-export const timeout = 30;$/m);
    assert.match(opts.prompt, /^\+export const timeout = 90;$/m);
    assert.match(opts.prompt, /@@/); // hunk header: the agent can see where the change lands
    // The file list stays, and the untracked file the patch omits is called
    // out by name as one the agent must open.
    assert.match(opts.prompt, /- new-file\.ts/);
    assert.match(opts.prompt, /Read each one before answering: new-file\.ts/);
  } finally {
    repo.cleanup();
  }
});

test('captureIntent still runs the diff itself, not the agent: reading files stays the only tool', async () => {
  const repo = await makeWorktreeWithChange();
  try {
    const { agent, lastInvoke } = spyAgent(JSON.stringify(VALID_PAYLOAD));
    await captureIntent(agent, ['login.ts'], repo.dir, 'haiku');

    const opts = lastInvoke();
    assert.equal(opts.cwd, repo.dir);
    assert.equal(opts.model, 'haiku');
    assert.equal(opts.permissionMode, 'default');
    // Read and nothing else — no Bash, so the agent cannot run `git diff`
    // (or anything else) even though its prompt is full of diff output.
    assert.deepEqual(opts.allowedTools, ['Read']);
    assert.match(opts.systemPrompt ?? '', /only read files/);
  } finally {
    repo.cleanup();
  }
});

test('captureIntent diffs against a custom baseRef, for the resume path where the change is already committed', async () => {
  const repo = await makeWorktreeWithChange();
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: repo.dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'committed change'], { cwd: repo.dir });

    const { agent, lastInvoke } = spyAgent(JSON.stringify(VALID_PAYLOAD));
    await captureIntent(agent, ['login.ts'], repo.dir, 'haiku', repo.headSha);

    // `git diff HEAD` would show nothing here; diffing the merge-base does.
    assert.match(lastInvoke().prompt, /^\+export const timeout = 90;$/m);
  } finally {
    repo.cleanup();
  }
});

test('a diff larger than the cap is truncated with a marker instead of swamping the model', async () => {
  const repo = await makeWorktreeWithChange();
  try {
    writeFileSync(join(repo.dir, 'login.ts'), Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
    const { agent, lastInvoke } = spyAgent(JSON.stringify(VALID_PAYLOAD));
    await captureIntent(agent, ['login.ts'], repo.dir, 'haiku');

    const prompt = lastInvoke().prompt;
    assert.match(prompt, /truncated the middle/);
    assert.ok(prompt.length < 30_000, `expected the prompt to stay bounded, got ${prompt.length} chars`);
  } finally {
    repo.cleanup();
  }
});

test('filesMissingFromDiff picks out exactly the files the patch does not cover', () => {
  const diffText = 'diff --git a/src/login.ts b/src/login.ts\n--- a/src/login.ts\n+++ b/src/login.ts\n@@\n+x\n';
  assert.deepEqual(filesMissingFromDiff(['src/login.ts', 'src/new-file.ts'], diffText), ['src/new-file.ts']);
  assert.deepEqual(filesMissingFromDiff(['src/login.ts'], diffText), []);
});

test('a worktree git cannot diff degrades to the file list, never a failed run', async () => {
  const { agent, lastInvoke } = spyAgent(JSON.stringify(VALID_PAYLOAD));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await captureIntent(agent, ['src/login.ts'], '/nonexistent-path-for-intent-test', 'haiku');
  } finally {
    console.log = originalLog;
  }

  const opts = lastInvoke();
  assert.match(opts.prompt, /- src\/login\.ts/);
  assert.doesNotMatch(opts.prompt, /--- begin diff ---/);
  assert.match(opts.prompt, /Read the ones you need/);
  assert.deepEqual(opts.allowedTools, ['Read']);
});

test('captureIntent forwards the given model to the agent so it is configurable per config/env var', async () => {
  const { agent, lastInvoke } = spyAgent(JSON.stringify(VALID_PAYLOAD));
  await captureIntent(agent, ['src/login.ts'], '/tmp', 'sonnet');
  assert.equal(lastInvoke().model, 'sonnet');
});

test('captureIntent accepts a short single-line commitMessage', async () => {
  const { intent } = await captureIntent(fakeAgent(JSON.stringify(VALID_PAYLOAD)), ['src/login.ts'], '/tmp', 'haiku');
  assert.equal(intent.commitMessage, 'feat: add login page');
});

test('captureIntent surfaces the agent turn\'s token usage when the adapter reports it, and omits it when not', async () => {
  const withUsage: AgentAdapter = {
    invoke: async () => ({ text: JSON.stringify(VALID_PAYLOAD), usage: { inputTokens: 1500, outputTokens: 400, totalTokens: 1900 } }),
  };
  const captured = await captureIntent(withUsage, ['src/login.ts'], '/tmp', 'haiku');
  assert.equal(captured.usage?.totalTokens, 1900);

  const withoutUsage = await captureIntent(fakeAgent(JSON.stringify(VALID_PAYLOAD)), ['src/login.ts'], '/tmp', 'haiku');
  assert.equal(withoutUsage.usage, undefined);
});

test('captureIntent rejects a multi-line commitMessage', async () => {
  const payload = { ...VALID_PAYLOAD, commitMessage: 'fix: things\n\n- bullet one\n- bullet two' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp', 'haiku'), /single line/);
});

test('captureIntent rejects a commitMessage longer than 72 characters', async () => {
  const payload = { ...VALID_PAYLOAD, commitMessage: 'fix: '.padEnd(80, 'x') };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp', 'haiku'));
});

test('captureIntent rejects an invalid risk level', async () => {
  const payload = { ...VALID_PAYLOAD, risk: 'critical' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp', 'haiku'));
});

test('captureIntent rejects an invalid changeType', async () => {
  const payload = { ...VALID_PAYLOAD, changeType: 'refactor' };
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify(payload)), ['src/login.ts'], '/tmp', 'haiku'));
});

test('captureIntent rejects a branchSlug with a prefix or uppercase characters', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, branchSlug: 'pipeline-worker/add-login-page' })), ['src/login.ts'], '/tmp', 'haiku'));
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, branchSlug: 'Add-Login-Page' })), ['src/login.ts'], '/tmp', 'haiku'));
});

test('captureIntent rejects empty fileChanges or testScenarios', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, fileChanges: [] })), ['src/login.ts'], '/tmp', 'haiku'));
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, testScenarios: [] })), ['src/login.ts'], '/tmp', 'haiku'));
});

test('captureIntent rejects multi-line values in fields rendered as a single line', async () => {
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, intent: 'line one\nline two' })), ['src/login.ts'], '/tmp', 'haiku'), /single line/);
  await assert.rejects(captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, riskReason: 'line one\nline two' })), ['src/login.ts'], '/tmp', 'haiku'), /single line/);
  await assert.rejects(
    captureIntent(fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, testScenarios: ['line one\nline two'] })), ['src/login.ts'], '/tmp', 'haiku'),
    /single line/,
  );
  await assert.rejects(
    captureIntent(
      fakeAgent(JSON.stringify({ ...VALID_PAYLOAD, fileChanges: [{ file: 'a.ts', summary: 'line one\nline two' }] })),
      ['src/login.ts'],
      '/tmp',
      'haiku',
    ),
    /single line/,
  );
});
