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
    // whenever -p/--prompt is also given a value.
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /-p|--prompt|DIFF-MARKER/);
    assert.equal(result.text, 'ok');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('copilotAdapter ignores opts.model (no per-invocation model flag) but warns instead of failing silently', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-copilot-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeCopilot = join(binDir, 'copilot');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakeCopilot, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakeCopilot, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  const origConsoleError = console.error;
  const warnings: unknown[][] = [];
  console.error = (...args: unknown[]) => warnings.push(args);
  try {
    await copilotAdapter.invoke({ prompt: 'hi', cwd: binDir, model: 'sonnet' });
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /sonnet|--model/);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /no per-invocation model flag.*sonnet/);
  } finally {
    console.error = origConsoleError;
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
