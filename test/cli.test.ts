/**
 * Drives the compiled CLI as a real subprocess, for behavior that can only be
 * observed at that level (e.g. commander's own --help rendering).
 *
 * NOTE: requires `npm run build` to have run first (exercises dist/cli.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');

test('pipeline-worker run --help documents the --target base-branch flag and the default branch it resolves', async () => {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('node', [cliPath, 'run', '--help']);
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });

  assert.match(stdout, /--target <branch>/);
  assert.match(stdout, /main or master/);
});
