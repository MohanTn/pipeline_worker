/**
 * Drives the compiled CLI's `update` subcommand as a subprocess, with a fake
 * `npm` shim on PATH standing in for the real npm registry (mirrors
 * cli.test.ts's convention for driving dist/cli.js, and claude.test.ts's
 * fake-shim convention for stubbing an external CLI).
 *
 * NOTE: requires `npm run build` to have run first (exercises dist/cli.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');

function withFakeNpm(script: string): { binDir: string; argsFile: string; cleanup: () => void } {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-update-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(join(binDir, 'npm'), `#!/bin/sh\necho "$@" > "${argsFile}"\n${script}\n`);
  chmodSync(join(binDir, 'npm'), 0o755);
  return { binDir, argsFile, cleanup: () => rmSync(topDir, { recursive: true, force: true }) };
}

test('pipeline-worker update installs pipeline-worker@latest globally via npm', async () => {
  const { binDir, argsFile, cleanup } = withFakeNpm('exit 0');
  try {
    const { stdout } = await execFileAsync('node', [cliPath, 'update'], {
      env: { ...process.env, PATH: binDir + ':' + process.env.PATH },
    });
    assert.match(readFileSync(argsFile, 'utf-8'), /install -g pipeline-worker@latest/);
    assert.match(stdout, /updated/);
  } finally {
    cleanup();
  }
});

test('pipeline-worker update exits non-zero and reports the failure when npm install fails', async () => {
  const { binDir, cleanup } = withFakeNpm('echo "network down" >&2\nexit 1');
  try {
    await assert.rejects(
      () => execFileAsync('node', [cliPath, 'update'], { env: { ...process.env, PATH: binDir + ':' + process.env.PATH } }),
      (err: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
        return err.code === 1 && /pipeline-worker update failed/.test(err.stderr ?? '');
      },
    );
  } finally {
    cleanup();
  }
});
