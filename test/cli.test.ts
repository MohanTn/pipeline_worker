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

function cliOutput(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('node', [cliPath, ...args]);
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

test('pipeline-worker run --help documents the --target base-branch flag and the default branch it resolves', async () => {
  const stdout = await cliOutput(['run', '--help']);

  assert.match(stdout, /--target <branch>/);
  assert.match(stdout, /main or master/);
});

test('pipeline-worker fix --help says it requires a branch and names the bots it answers', async () => {
  const stdout = await cliOutput(['fix', '--help']);

  assert.match(stdout, /--branch <name>/);
  assert.match(stdout, /CodeRabbit, SonarQube, Checkmarx/);
  assert.match(stdout, /--include-own/);
});
