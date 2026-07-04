/**
 * Unit tests for the startup auto-update check, run against the .ts source
 * directly (tsx makes that possible per package.json's test script) rather
 * than the compiled CLI, since these exercise the module's exported
 * functions in isolation. Mirrors updateCli.test.ts's fake-npm-on-PATH
 * convention for stubbing out the real npm registry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLatestVersion, fetchLatestVersion, installVersion } from '../src/version/autoUpdate.js';

function withFakeNpm(script: string): { binDir: string; argsFile: string; cleanup: () => void } {
  const topDir = mkdtempSync(join(tmpdir(), 'pw-autoupdate-fake-'));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(join(binDir, 'npm'), `#!/bin/sh\necho "$@" >> "${argsFile}"\n${script}\n`);
  chmodSync(join(binDir, 'npm'), 0o755);
  return { binDir, argsFile, cleanup: () => rmSync(topDir, { recursive: true, force: true }) };
}

function withPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${binDir}:${original}`;
  return fn().finally(() => {
    process.env.PATH = original;
  });
}

test('fetchLatestVersion resolves the version printed by npm view', async () => {
  const { binDir, cleanup } = withFakeNpm('echo "9.9.9"');
  try {
    const version = await withPath(binDir, () => fetchLatestVersion('pipeline-worker'));
    assert.equal(version, '9.9.9');
  } finally {
    cleanup();
  }
});

test('fetchLatestVersion rejects when npm view fails (offline/unpublished)', async () => {
  const { binDir, cleanup } = withFakeNpm('exit 1');
  try {
    await assert.rejects(() => withPath(binDir, () => fetchLatestVersion('pipeline-worker')));
  } finally {
    cleanup();
  }
});

test('installVersion invokes npm install -g <pkg>@<version>', async () => {
  const { binDir, argsFile, cleanup } = withFakeNpm('exit 0');
  try {
    await withPath(binDir, () => installVersion('pipeline-worker', '9.9.9'));
    assert.match(readFileSync(argsFile, 'utf-8'), /install -g pipeline-worker@9\.9\.9/);
  } finally {
    cleanup();
  }
});

test('ensureLatestVersion installs the newer version when npm reports one', async () => {
  const { binDir, argsFile, cleanup } = withFakeNpm(
    // First invocation is `npm view` (echoes the version), second is
    // `npm install -g ...`; both must exit 0 for the fake to be usable twice.
    'case "$1" in\n  view) echo "2.0.0" ;;\n  install) exit 0 ;;\nesac',
  );
  try {
    const installed = await withPath(binDir, () => ensureLatestVersion('pipeline-worker', '1.0.0'));
    assert.equal(installed, '2.0.0');
    assert.match(readFileSync(argsFile, 'utf-8'), /install -g pipeline-worker@2\.0\.0/);
  } finally {
    cleanup();
  }
});

test('ensureLatestVersion is a no-op when the installed version is already latest', async () => {
  const { binDir, argsFile, cleanup } = withFakeNpm('case "$1" in\n  view) echo "1.0.0" ;;\n  install) exit 0 ;;\nesac');
  try {
    const installed = await withPath(binDir, () => ensureLatestVersion('pipeline-worker', '1.0.0'));
    assert.equal(installed, undefined);
    assert.doesNotMatch(readFileSync(argsFile, 'utf-8'), /install/);
  } finally {
    cleanup();
  }
});

test('ensureLatestVersion swallows an unreachable registry and returns undefined', async () => {
  const { binDir, cleanup } = withFakeNpm('exit 1');
  try {
    const installed = await withPath(binDir, () => ensureLatestVersion('pipeline-worker', '1.0.0'));
    assert.equal(installed, undefined);
  } finally {
    cleanup();
  }
});

test('ensureLatestVersion swallows an install failure and returns undefined', async () => {
  const { binDir, cleanup } = withFakeNpm('case "$1" in\n  view) echo "2.0.0" ;;\n  install) echo "network down" >&2; exit 1 ;;\nesac');
  try {
    const installed = await withPath(binDir, () => ensureLatestVersion('pipeline-worker', '1.0.0'));
    assert.equal(installed, undefined);
  } finally {
    cleanup();
  }
});
