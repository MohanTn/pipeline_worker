/**
 * Tests for src/agent/pi.ts. Exercises the live piAdapter by putting a tiny
 * shell script named `pi` on PATH, mirroring copilot.test.ts's fake-shim
 * approach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piAdapter } from '../src/agent/pi.js';

test('piAdapter always passes --provider github-copilot', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-pi-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(binDir, 'pi');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakePi, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakePi, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await piAdapter.invoke({ prompt: 'hi', cwd: binDir });
    const args = readFileSync(argsFile, 'utf-8').trim().split(/\s+/);
    const providerIndex = args.indexOf('--provider');
    assert.ok(providerIndex !== -1, '--provider flag was not passed');
    assert.equal(args[providerIndex + 1], 'github-copilot');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('piAdapter passes no --model flag when opts.model is unset, so pi falls back to the provider\'s own default', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-pi-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(binDir, 'pi');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakePi, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakePi, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await piAdapter.invoke({ prompt: 'hi', cwd: binDir });
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /--model/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('piAdapter passes --model verbatim when the user entered one manually, since pi model ids (provider/id) are never guessed here', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-pi-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(binDir, 'pi');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakePi, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakePi, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await piAdapter.invoke({ prompt: 'hi', cwd: binDir, model: 'github-copilot/gpt-4.1' });
    const args = readFileSync(argsFile, 'utf-8').trim().split(/\s+/);
    assert.equal(args[args.indexOf('--model') + 1], 'github-copilot/gpt-4.1');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('piAdapter delivers the prompt over stdin rather than argv, avoiding E2BIG on large diffs', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-pi-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(binDir, 'pi');
  const argsFile = join(topDir, 'args.txt');
  const stdinFile = join(topDir, 'stdin.txt');
  writeFileSync(fakePi, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > "${stdinFile}"\necho 'ok'\n`);
  chmodSync(fakePi, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    const bigPrompt = 'DIFF-MARKER-' + 'x'.repeat(200_000);
    const result = await piAdapter.invoke({ prompt: bigPrompt, cwd: binDir });
    assert.equal(readFileSync(stdinFile, 'utf-8'), bigPrompt);
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /DIFF-MARKER/);
    assert.equal(result.text, 'ok');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('piAdapter passes a unique --name and reports it back as sessionId, since print mode never returns pi\'s own session id', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-pi-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(binDir, 'pi');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakePi, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakePi, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    const result = await piAdapter.invoke({ prompt: 'hi', cwd: binDir });
    const args = readFileSync(argsFile, 'utf-8').trim().split(/\s+/);
    const nameIndex = args.indexOf('--name');
    assert.ok(nameIndex !== -1);
    assert.equal(args[nameIndex + 1], result.sessionId);
    assert.match(result.sessionId ?? '', /^pipeline-worker-/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('piAdapter maps Claude-style allowedTools to pi\'s lowercase, unscoped names', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-pi-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(binDir, 'pi');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakePi, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\necho 'ok'\n`);
  chmodSync(fakePi, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await piAdapter.invoke({ prompt: 'hi', cwd: binDir, allowedTools: ['Read', 'Glob', 'Bash(git diff:*)'] });
    const args = readFileSync(argsFile, 'utf-8').trim().split(/\s+/);
    assert.equal(args[args.indexOf('--tools') + 1], 'read,find,bash');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('piAdapter extracts the JSON object from the response text when jsonSchema is set', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-pi-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(binDir, 'pi');
  writeFileSync(fakePi, `#!/bin/sh\ncat > /dev/null\necho 'sure, here you go: {"a":1} — hope that helps'\n`);
  chmodSync(fakePi, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    const result = await piAdapter.invoke({ prompt: 'hi', cwd: binDir, jsonSchema: { type: 'object' } });
    assert.equal(result.text, '{"a":1}');
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});
