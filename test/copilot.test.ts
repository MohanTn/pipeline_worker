/**
 * Tests for src/agent/copilot.ts. Exercises the live copilotAdapter by
 * putting a tiny shell script named `copilot` on PATH, mirroring
 * claude.test.ts's fake-shim approach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotAdapter } from '../src/agent/copilot.js';

test('copilotAdapter delivers the prompt over stdin rather than argv, avoiding E2BIG on large diffs', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-copilot-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeCopilot = join(binDir, 'copilot');
  const argsFile = join(topDir, 'args.txt');
  const stdinFile = join(topDir, 'stdin.txt');
  writeFileSync(fakeCopilot, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > "${stdinFile}"\necho 'ok'\n`);
  chmodSync(fakeCopilot, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    // Bigger than Linux's MAX_ARG_STRLEN (128KB) — this would have failed
    // with E2BIG under the old argv-based invocation.
    const bigPrompt = 'DIFF-MARKER-' + 'x'.repeat(200_000);
    const result = await copilotAdapter.invoke({ prompt: bigPrompt, cwd: binDir });
    assert.equal(readFileSync(stdinFile, 'utf-8'), bigPrompt);
    // -p is omitted entirely: GitHub's docs say piped stdin is ignored
    // whenever -p/--prompt is also given a value. Matched as whole
    // whitespace-delimited tokens so this doesn't false-positive on flags
    // like --allow-all-paths that merely contain the substring "-p".
    const argTokens = readFileSync(argsFile, 'utf-8').trim().split(/\s+/);
    assert.ok(!argTokens.includes('-p'));
    assert.ok(!argTokens.includes('--prompt'));
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /DIFF-MARKER/);
    assert.equal(result.text, 'ok');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('copilotAdapter passes a unique --name and reports it back as sessionId, since the CLI has no way to report its own session id', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-copilot-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeCopilot = join(binDir, 'copilot');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakeCopilot, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakeCopilot, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    const result = await copilotAdapter.invoke({ prompt: 'hi', cwd: binDir });
    const args = readFileSync(argsFile, 'utf-8').trim().split(/\s+/);
    const nameIndex = args.indexOf('--name');
    assert.ok(nameIndex !== -1);
    assert.equal(args[nameIndex + 1], result.sessionId);
    assert.match(result.sessionId ?? '', /^pipeline-worker-/);
    assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

// Copilot's --model takes its own model names, so the Claude CLI aliases the
// config defaults to (intentModel: "haiku") must be translated, while an
// explicit copilot-native name must pass through untouched.
for (const [model, expected] of [
  ['haiku', 'claude-haiku-4.5'],
  ['sonnet', 'claude-sonnet-4.5'],
  ['gpt-5', 'gpt-5'],
] as const) {
  test(`copilotAdapter passes --model ${expected} for opts.model "${model}"`, { skip: process.platform === 'win32' }, async () => {
    const topDir = mkdtempSync(join(tmpdir(), 'pw-copilot-fake-'));
    const binDir = join(topDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeCopilot = join(binDir, 'copilot');
    const argsFile = join(topDir, 'args.txt');
    writeFileSync(fakeCopilot, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
    chmodSync(fakeCopilot, 0o755);

    const origPath = process.env.PATH;
    process.env.PATH = binDir + (origPath ? ':' + origPath : '');
    try {
      await copilotAdapter.invoke({ prompt: 'hi', cwd: binDir, model });
      const args = readFileSync(argsFile, 'utf-8').trim().split(/\s+/);
      assert.equal(args[args.indexOf('--model') + 1], expected);
    } finally {
      process.env.PATH = origPath;
      rmSync(topDir, { recursive: true, force: true });
    }
  });
}

test('copilotAdapter passes no --model flag when opts.model is unset', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-copilot-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeCopilot = join(binDir, 'copilot');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakeCopilot, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakeCopilot, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await copilotAdapter.invoke({ prompt: 'hi', cwd: binDir });
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /--model/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('copilotAdapter appends the JSON schema to the piped prompt when jsonSchema is set', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-copilot-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeCopilot = join(binDir, 'copilot');
  const stdinFile = join(topDir, 'stdin.txt');
  writeFileSync(fakeCopilot, `#!/bin/sh\ncat > "${stdinFile}"\necho '{"a":1}'\n`);
  chmodSync(fakeCopilot, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    const result = await copilotAdapter.invoke({ prompt: 'hi', cwd: binDir, jsonSchema: { type: 'object' } });
    assert.match(readFileSync(stdinFile, 'utf-8'), /"type":"object"/);
    assert.equal(result.text, '{"a":1}');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});
