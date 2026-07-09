/**
 * Tests for src/agent/claude.ts. The unit tests pin the formatProcessError
 * helper; the integration test exercises the live claudeAdapter by putting a
 * tiny shell script named `claude` on PATH that prints to stdout and stderr
 * then exits non-zero — verifying that the real adapter actually surfaces
 * both streams (and the exit code) end-to-end, not just the helper.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, formatProcessError } from '../src/agent/claude.js';

test('formatProcessError names a non-zero exit code', () => {
  const msg = formatProcessError({ code: 1, stdout: 'o', stderr: 'e' });
  assert.ok(msg.startsWith('claude exited with code 1.'));
  assert.ok(msg.includes('--- stdout ---\no'));
  assert.ok(msg.includes('--- stderr ---\ne'));
});

test('formatProcessError prefers signal over exit code when both are present', () => {
  const msg = formatProcessError({ code: 1, signal: 'SIGTERM', stdout: 'o', stderr: 'e' });
  assert.ok(msg.startsWith('claude killed by signal SIGTERM.'));
  assert.doesNotMatch(msg, /exited with code/);
});

test('formatProcessError truncates very large stdout to the last N chars and marks the drop', () => {
  const huge = 'x'.repeat(10_000);
  const msg = formatProcessError({ code: 1, stdout: huge, stderr: '' });
  assert.ok(msg.startsWith('claude exited with code 1.'));
  assert.match(msg, /--- stdout ---/);
  assert.match(msg, /6000 chars truncated, showing last 4000/);
  // First 6000 chars were dropped, so a long unbroken run of x's is preserved
  // only as the trailing 4000 — not as the start of the stdout block.
  assert.ok(!msg.includes('x'.repeat(5_000)));
  assert.ok(msg.includes('x'.repeat(4_000)));
});

test('formatProcessError does not mark short output as truncated', () => {
  const msg = formatProcessError({ code: 1, stdout: 'short', stderr: 'short' });
  assert.ok(!msg.includes('truncated'));
  assert.ok(msg.includes('--- stdout ---\nshort'));
});

test('formatProcessError handles the no-cause ENOENT case via underlying message', () => {
  const msg = formatProcessError({ message: 'spawn claude ENOENT' });
  assert.match(msg, /failed with no exit code or signal reported/);
  assert.match(msg, /\(underlying: spawn claude ENOENT\)/);
});

test('formatProcessError omits empty stdout and stderr blocks', () => {
  const msg = formatProcessError({ code: 2, stdout: '', stderr: '   ' });
  assert.doesNotMatch(msg, /--- stdout ---/);
  assert.doesNotMatch(msg, /--- stderr ---/);
});

test('formatProcessError trims surrounding whitespace but preserves inner content', () => {
  const msg = formatProcessError({
    code: 1,
    stdout: '  line1\nline2\n',
    stderr: '\n\nbye\n\n',
  });
  assert.match(msg, /--- stdout ---\nline1\nline2/);
  assert.match(msg, /--- stderr ---\nbye/);
});

test('claudeAdapter rethrows non-zero exit with stdout, stderr, and exit code visible', { skip: process.platform === 'win32' }, async () => {
  // The integration test stands up a fake `claude` shim on PATH and asserts
  // the live adapter surfaces the actual exit code, stdout, and stderr.
  // Skipped on Windows: execFile's PATH search for bare names and the
  // /bin/sh shebang are POSIX-only. CI runs on Linux (see
  // .github/workflows/ci.yml) so this stays green there.
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  writeFileSync(
    fakeClaude,
    '#!/bin/sh\necho \'{"is_error":true,"error":"not authenticated"}\'\necho \'Warning: no stdin\' >&2\nexit 7\n',
  );
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await assert.rejects(
      () =>
        claudeAdapter.invoke({
          prompt: 'anything',
          cwd: binDir,
          jsonSchema: { type: 'object' },
        }),
      (err: Error) => {
        // First line must be the cause; the remaining fragments are verbatim
        // from stdout/stderr. Substring checks (instead of a single regex)
        // keep the assertions resilient if we later add a `(command: …)`
        // prefix line.
        const lines = err.message.split('\n');
        return (
          lines[0] === 'claude exited with code 7.' &&
          err.message.includes('not authenticated') &&
          err.message.includes('Warning: no stdin')
        );
      },
    );
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('claudeAdapter passes --model through to the CLI when opts.model is set', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" > "${argsFile}"\necho '{"result":"ok"}'\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await claudeAdapter.invoke({ prompt: 'hi', cwd: binDir, model: 'haiku' });
    assert.match(readFileSync(argsFile, 'utf-8'), /--model haiku/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('claudeAdapter omits --model when opts.model is not set', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" > "${argsFile}"\necho '{"result":"ok"}'\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await claudeAdapter.invoke({ prompt: 'hi', cwd: binDir });
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /--model/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('claudeAdapter passes --allowedTools through to the CLI when opts.allowedTools is set', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" > "${argsFile}"\necho '{"result":"ok"}'\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await claudeAdapter.invoke({ prompt: 'hi', cwd: binDir, allowedTools: ['Read', 'Bash(git diff:*)'] });
    assert.match(readFileSync(argsFile, 'utf-8'), /--allowedTools Read Bash\(git diff:\*\)/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('claudeAdapter omits --allowedTools when opts.allowedTools is not set', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" > "${argsFile}"\necho '{"result":"ok"}'\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    await claudeAdapter.invoke({ prompt: 'hi', cwd: binDir });
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /--allowedTools/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('claudeAdapter surfaces session_id and duration_ms from the CLI\'s JSON envelope', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  writeFileSync(fakeClaude, `#!/bin/sh\ncat > /dev/null\necho '{"result":"ok","session_id":"abc-123","duration_ms":42}'\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    const result = await claudeAdapter.invoke({ prompt: 'hi', cwd: binDir });
    assert.equal(result.sessionId, 'abc-123');
    assert.equal(result.durationMs, 42);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('claudeAdapter falls back to a wall-clock duration when the JSON envelope omits duration_ms', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  writeFileSync(fakeClaude, `#!/bin/sh\ncat > /dev/null\necho '{"result":"ok"}'\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    const result = await claudeAdapter.invoke({ prompt: 'hi', cwd: binDir });
    assert.equal(result.sessionId, undefined);
    assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

test('claudeAdapter delivers the prompt over stdin rather than argv, avoiding E2BIG on large diffs', { skip: process.platform === 'win32' }, async () => {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  const argsFile = join(topDir, 'args.txt');
  const stdinFile = join(topDir, 'stdin.txt');
  writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > "${stdinFile}"\necho '{"result":"ok"}'\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    // Bigger than Linux's MAX_ARG_STRLEN (128KB) — this would have failed
    // with E2BIG under the old argv-based invocation.
    const bigPrompt = 'DIFF-MARKER-' + 'x'.repeat(200_000);
    await claudeAdapter.invoke({ prompt: bigPrompt, cwd: binDir });
    assert.equal(readFileSync(stdinFile, 'utf-8'), bigPrompt);
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /DIFF-MARKER/);
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
});

/** Runs claudeAdapter against a fake `claude` on PATH that prints `envelope` verbatim, returning the parsed result. */
async function invokeWithEnvelope(envelope: string): Promise<Awaited<ReturnType<typeof claudeAdapter.invoke>>> {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-claude-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, 'claude');
  const envelopeFile = join(topDir, 'envelope.json');
  writeFileSync(envelopeFile, envelope);
  writeFileSync(fakeClaude, `#!/bin/sh\ncat > /dev/null\ncat "${envelopeFile}"\n`);
  chmodSync(fakeClaude, 0o755);

  const origPath = process.env.PATH;
  process.env.PATH = binDir + (origPath ? ':' + origPath : '');
  try {
    return await claudeAdapter.invoke({ prompt: 'hi', cwd: binDir });
  } finally {
    process.env.PATH = origPath;
    rmSync(topDir, { recursive: true, force: true });
  }
}

test('claudeAdapter extracts token usage from the CLI envelope, folding cache tokens into inputTokens', { skip: process.platform === 'win32' }, async () => {
  const result = await invokeWithEnvelope(
    JSON.stringify({
      result: 'ok',
      session_id: 's-1',
      duration_ms: 1200,
      usage: { input_tokens: 100, output_tokens: 400, cache_creation_input_tokens: 300, cache_read_input_tokens: 1100 },
      total_cost_usd: 0.0123,
      num_turns: 3,
    }),
  );
  assert.equal(result.usage?.inputTokens, 1500);
  assert.equal(result.usage?.outputTokens, 400);
  assert.equal(result.usage?.totalTokens, 1900);
  assert.equal(result.usage?.costUsd, 0.0123);
  assert.equal(result.usage?.numTurns, 3);
});

test('claudeAdapter leaves usage undefined when the envelope has none', { skip: process.platform === 'win32' }, async () => {
  const result = await invokeWithEnvelope(JSON.stringify({ result: 'ok', session_id: 's-1', duration_ms: 5 }));
  assert.equal(result.text, 'ok');
  assert.equal(result.usage, undefined);
});

test('claudeAdapter degrades malformed usage fields to undefined instead of throwing', { skip: process.platform === 'win32' }, async () => {
  const result = await invokeWithEnvelope(
    JSON.stringify({ result: 'ok', usage: { input_tokens: 'lots', output_tokens: -3 }, total_cost_usd: 'cheap', num_turns: null }),
  );
  assert.equal(result.text, 'ok');
  assert.equal(result.usage, undefined);
});

test('claudeAdapter reports partial usage when only one side is a valid count', { skip: process.platform === 'win32' }, async () => {
  const result = await invokeWithEnvelope(JSON.stringify({ result: 'ok', usage: { output_tokens: 250 } }));
  assert.equal(result.usage?.inputTokens, undefined);
  assert.equal(result.usage?.outputTokens, 250);
  assert.equal(result.usage?.totalTokens, 250);
});
