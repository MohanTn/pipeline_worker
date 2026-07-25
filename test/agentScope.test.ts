/**
 * How narrowly each agent turn is scoped: the claude argv it produces
 * (`--bare`, `--system-prompt`, the `--tools` gate paired with
 * `--allowedTools`), the prompt assembly used by the adapters whose CLI has no
 * such flags, and the little-coder adapter's context budget.
 *
 * The adapter-level tests stand a fake executable up on PATH (or point the
 * configurable binary at one) and read back the argv/stdin it received —
 * same convention as claude.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClaudeArgs, toolGateNames, createClaudeAdapter } from '../src/agent/claude.js';
import { composePrompt, truncateToBudget } from '../src/agent/promptText.js';
import { createLittleCoderAdapter, mapLittleCoderTools } from '../src/agent/littleCoder.js';
import { selectAgent } from '../src/agent/index.js';
import type { PipelineWorkerConfig } from '../src/types.js';

/** A fake CLI that records its argv and stdin, then prints `stdout`. */
function fakeCli(name: string, stdout: string): { dir: string; binary: string; argsFile: string; stdinFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pw-fake-agent-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, name);
  const argsFile = join(dir, 'args.txt');
  const stdinFile = join(dir, 'stdin.txt');
  writeFileSync(binary, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > "${stdinFile}"\ncat <<'PW_EOF'\n${stdout}\nPW_EOF\n`);
  chmodSync(binary, 0o755);
  return { dir, binary, argsFile, stdinFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('toolGateNames strips the scope from an allowlist entry and dedupes', () => {
  assert.deepEqual(toolGateNames(['Read', 'Bash(git diff:*)', 'Bash(git status:*)', 'Write']), ['Read', 'Bash', 'Write']);
  assert.deepEqual(toolGateNames([]), []);
});

test('an allowlisted turn gets both the --tools gate and --allowedTools, so it cannot ask for a tool it was not given', () => {
  const args = buildClaudeArgs({ prompt: 'p', cwd: '/tmp', allowedTools: ['Read', 'Write', 'Edit'], permissionMode: 'acceptEdits' });
  const gateIndex = args.indexOf('--tools');
  assert.notEqual(gateIndex, -1);
  assert.equal(args[gateIndex + 1], 'Read,Write,Edit');
  assert.ok(args.includes('--allowedTools'));
});

test('a turn with no allowlist (the CI-fix path) leaves the tool set alone', () => {
  const args = buildClaudeArgs({ prompt: 'p', cwd: '/tmp' });
  assert.ok(!args.includes('--tools'));
  assert.ok(!args.includes('--allowedTools'));
});

test('--bare is opt-in per adapter instance: config.bareAgentMode decides, since it forces API-key-only auth', () => {
  assert.ok(!buildClaudeArgs({ prompt: 'p', cwd: '/tmp' }).includes('--bare'));
  assert.ok(buildClaudeArgs({ prompt: 'p', cwd: '/tmp' }, true).includes('--bare'));
});

test('systemPrompt becomes --system-prompt, and is omitted when the caller sets none', () => {
  const args = buildClaudeArgs({ prompt: 'p', cwd: '/tmp', systemPrompt: 'You resolve conflicts.' });
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'You resolve conflicts.');
  assert.ok(!buildClaudeArgs({ prompt: 'p', cwd: '/tmp' }).includes('--system-prompt'));
});

test('createClaudeAdapter({ bare: true }) really passes --bare to the CLI', { skip: process.platform === 'win32' }, async () => {
  const fake = fakeCli('claude', '{"result":"ok"}');
  const origPath = process.env.PATH;
  process.env.PATH = join(fake.dir, 'bin') + (origPath ? ':' + origPath : '');
  try {
    await createClaudeAdapter({ bare: true }).invoke({ prompt: 'hi', cwd: fake.dir, systemPrompt: 'sys', allowedTools: ['Read'] });
    const argv = readFileSync(fake.argsFile, 'utf-8');
    assert.match(argv, /--bare/);
    assert.match(argv, /--system-prompt sys/);
    assert.match(argv, /--tools Read/);
  } finally {
    process.env.PATH = origPath;
    fake.cleanup();
  }
});

test('composePrompt puts the system instruction first and the output contract last', () => {
  const composed = composePrompt({ systemPrompt: 'SYS', prompt: 'TASK', jsonSchema: { type: 'object' } });
  assert.ok(composed.startsWith('SYS'));
  assert.ok(composed.indexOf('TASK') > composed.indexOf('SYS'));
  assert.ok(composed.indexOf('JSON Schema') > composed.indexOf('TASK'));
  assert.equal(composePrompt({ prompt: 'TASK' }), 'TASK');
});

test('truncateToBudget keeps both ends of an over-long prompt and marks the gap', () => {
  const text = `HEAD${'x'.repeat(5000)}TAIL`;
  const trimmed = truncateToBudget(text, 400);
  assert.ok(trimmed.length <= 400);
  assert.ok(trimmed.startsWith('HEAD'));
  assert.ok(trimmed.endsWith('TAIL'));
  assert.match(trimmed, /truncated the middle/);
});

test('truncateToBudget leaves a prompt inside the budget untouched, and 0 disables the cap', () => {
  assert.equal(truncateToBudget('short', 400), 'short');
  assert.equal(truncateToBudget('x'.repeat(5000), 0).length, 5000);
});

test('mapLittleCoderTools maps onto pi\'s four built-ins and drops what it has no equivalent for', () => {
  assert.deepEqual(mapLittleCoderTools(['Read', 'Write', 'Edit']), ['read', 'write', 'edit']);
  assert.deepEqual(mapLittleCoderTools(['Bash(git diff:*)']), ['bash']);
  assert.deepEqual(mapLittleCoderTools(['Read', 'Grep', 'Glob']), ['read']);
});

test('the little-coder adapter invokes the configured binary with pi flags and pipes the prompt', { skip: process.platform === 'win32' }, async () => {
  const fake = fakeCli('little-coder', '{"summary":"ok"}');
  try {
    const adapter = createLittleCoderAdapter({ binary: fake.binary, maxPromptChars: 0 });
    const result = await adapter.invoke({
      prompt: 'TASK',
      systemPrompt: 'SYS',
      cwd: fake.dir,
      model: 'llamacpp/qwen3-30b',
      allowedTools: ['Read'],
      jsonSchema: { type: 'object' },
    });

    const argv = readFileSync(fake.argsFile, 'utf-8');
    assert.match(argv, /-p/);
    assert.match(argv, /--model llamacpp\/qwen3-30b/);
    assert.match(argv, /--tools read/);
    const stdin = readFileSync(fake.stdinFile, 'utf-8');
    assert.ok(stdin.startsWith('SYS'));
    assert.match(stdin, /TASK/);
    assert.match(stdin, /JSON Schema/);
    assert.equal(result.text, '{"summary":"ok"}');
  } finally {
    fake.cleanup();
  }
});

test('the little-coder adapter trims the prompt to the configured context budget', { skip: process.platform === 'win32' }, async () => {
  const fake = fakeCli('little-coder', 'ok');
  try {
    const adapter = createLittleCoderAdapter({ binary: fake.binary, maxPromptChars: 500 });
    await adapter.invoke({ prompt: `START${'y'.repeat(9000)}END`, cwd: fake.dir });

    const stdin = readFileSync(fake.stdinFile, 'utf-8');
    assert.ok(stdin.length <= 501, `expected the prompt to be capped, got ${stdin.length} chars`); // +1 for the shell's trailing newline
    assert.match(stdin, /^START/);
    assert.match(stdin, /truncated the middle/);
  } finally {
    fake.cleanup();
  }
});

test('selectAgent builds the little-coder adapter from config, binary and budget included', { skip: process.platform === 'win32' }, async () => {
  const fake = fakeCli('little-coder', 'ok');
  try {
    const config = { agent: 'little-coder', bareAgentMode: true, littleCoder: { binary: fake.binary, maxPromptChars: 0 } } as PipelineWorkerConfig;
    await selectAgent(config).invoke({ prompt: 'hello', cwd: fake.dir });
    assert.match(readFileSync(fake.stdinFile, 'utf-8'), /hello/);
  } finally {
    fake.cleanup();
  }
});
