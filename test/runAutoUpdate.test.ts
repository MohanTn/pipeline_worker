/**
 * Confirms `pipeline-worker run` checks npm for a newer version and installs
 * it before doing any workflow work, driving the compiled CLI as a
 * subprocess against a fake `npm` shim on PATH (mirrors updateCli.test.ts
 * and cli.test.ts's conventions for stubbing external CLIs).
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
  const topDir = mkdtempSync(join(tmpdir(), 'pw-run-autoupdate-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(join(binDir, 'npm'), `#!/bin/sh\necho "$@" >> "${argsFile}"\n${script}\n`);
  chmodSync(join(binDir, 'npm'), 0o755);
  return { binDir, argsFile, cleanup: () => rmSync(topDir, { recursive: true, force: true }) };
}

// `pipeline-worker run` fails fast on a non-git, non-configured directory —
// captureDiff's `git diff` errors out immediately after the version check
// runs, which is enough to observe check-then-proceed ordering without
// needing a full repo/config fixture.
test('pipeline-worker run checks npm for updates before starting the workflow', async () => {
  const { binDir, argsFile, cleanup } = withFakeNpm('case "$1" in\n  view) echo "9.9.9" ;;\n  install) exit 0 ;;\nesac');
  const workDir = mkdtempSync(join(tmpdir(), 'pw-run-autoupdate-cwd-'));
  try {
    await assert.rejects(() =>
      execFileAsync('node', [cliPath, 'run'], {
        cwd: workDir,
        env: { ...process.env, PATH: binDir + ':' + process.env.PATH, PIPELINE_WORKER_FORGE: 'github' },
      }),
    );
    assert.match(readFileSync(argsFile, 'utf-8'), /view pipeline-worker version/);
    assert.match(readFileSync(argsFile, 'utf-8'), /install -g pipeline-worker@9\.9\.9/);
  } finally {
    cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('pipeline-worker run proceeds without installing when already on the latest version', async () => {
  const currentVersion = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')).version as string;
  const { binDir, argsFile, cleanup } = withFakeNpm(`case "$1" in\n  view) echo "${currentVersion}" ;;\n  install) exit 0 ;;\nesac`);
  const workDir = mkdtempSync(join(tmpdir(), 'pw-run-autoupdate-cwd-'));
  try {
    await assert.rejects(() =>
      execFileAsync('node', [cliPath, 'run'], {
        cwd: workDir,
        env: { ...process.env, PATH: binDir + ':' + process.env.PATH, PIPELINE_WORKER_FORGE: 'github' },
      }),
    );
    assert.match(readFileSync(argsFile, 'utf-8'), /view pipeline-worker version/);
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /install/);
  } finally {
    cleanup();
    rmSync(workDir, { recursive: true, force: true });
  }
});
