/**
 * Best-effort startup version check for `pipeline-worker run`: compares the
 * running binary's version against the latest one published on npm and
 * installs it if they differ, so a stale global install doesn't silently
 * keep running old workflow logic. Also backs the `update` command's manual
 * `npm install -g <pkg>@latest`.
 *
 * Network/npm failures here must never block a run — the caller only ever
 * sees a resolved value, never a rejection.
 */

import { spawn } from 'node:child_process';

function runNpm(args: string[], stdio: 'pipe' | 'inherit'): Promise<string> {
  return new Promise((resolve, reject) => {
    const npm = spawn('npm', args, { stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    npm.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    npm.on('error', reject);
    npm.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`npm ${args.join(' ')} exited with code ${code}`))));
  });
}

/** Reads the version npm currently has tagged for `pkgName` (e.g. the `latest` dist-tag). */
export function fetchLatestVersion(pkgName: string): Promise<string> {
  return runNpm(['view', pkgName, 'version'], 'pipe').then((out) => out.trim());
}

/**
 * `stdio: 'inherit'` streams npm's own progress/errors straight to the
 * user's terminal rather than buffering it — an install can take a while
 * and users expect to see npm's usual output live.
 */
export function installVersion(pkgName: string, versionOrTag: string): Promise<void> {
  return runNpm(['install', '-g', `${pkgName}@${versionOrTag}`], 'inherit').then(() => undefined);
}

/**
 * Checks npm for the latest published version of `pkgName` and installs it
 * globally if it differs from `currentVersion`. Returns the newly installed
 * version, or `undefined` when already current, offline, or the install
 * itself failed — those cases are logged to the console and swallowed
 * rather than thrown, since a failed update check must never stop the
 * workflow that's about to start.
 */
export async function ensureLatestVersion(pkgName: string, currentVersion: string): Promise<string | undefined> {
  let latest: string;
  try {
    latest = await fetchLatestVersion(pkgName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: could not check npm for a newer ${pkgName} version (${message}). Continuing with v${currentVersion}.`);
    return undefined;
  }
  if (latest === currentVersion) return undefined;

  console.log(`pipeline-worker: v${currentVersion} installed, v${latest} available on npm — installing...`);
  try {
    await installVersion(pkgName, latest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to auto-update ${pkgName} to v${latest} (${message}). Continuing with v${currentVersion}.`);
    return undefined;
  }
  console.log(`pipeline-worker: updated to v${latest} (takes effect on the next run) — continuing this run with v${currentVersion}.`);
  return latest;
}
