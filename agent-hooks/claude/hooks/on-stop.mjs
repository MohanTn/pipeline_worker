#!/usr/bin/env node
/**
 * Shared stop-of-turn hook for both Claude Code (`Stop` event) and GitHub
 * Copilot CLI (`agentStop` event). Both deliver a similar JSON payload on
 * stdin (Claude: cwd/stop_hook_active/stop_reason; Copilot: cwd/sessionId/
 * stopReason) — this script only reads the one field both share, `cwd`.
 *
 * If the turn just ended in a repo with uncommitted changes and no
 * pipeline-worker run already in flight, kick off `pipeline-worker run`
 * detached so it doesn't block the agent's own session, then get out of the
 * way. Every check below is a silent no-op on the "nothing to do" path —
 * this hook fires after *every* assistant turn in *every* repo, so it must
 * never be noisy or slow when there's nothing for it to trigger.
 */

import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function isGitWorkTree(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function hasUncommittedChanges(cwd) {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}

/** Spawns `pipeline-worker run` detached and waits only long enough to know whether the spawn itself succeeded (e.g. binary missing) — not for the run to finish. */
function spawnDetached(cwd, logPath) {
  return new Promise((resolve) => {
    const logFd = openSync(logPath, 'a');
    const child = spawn('pipeline-worker', ['run'], {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd); // the child dups its own reference at spawn time; the parent's copy isn't needed past this point
    child.once('error', () => resolve(false)); // e.g. ENOENT — not on PATH
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function emit(systemMessage) {
  // Claude Code reads `systemMessage`; unrecognized fields are expected to be
  // ignored by other consumers (e.g. Copilot CLI) per standard JSON handling.
  process.stdout.write(JSON.stringify({ systemMessage }) + '\n');
}

// fallow-ignore-next-line complexity
async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // no usable payload — nothing safe to act on
  }

  // Claude Code's re-entrancy guard: a Stop hook's own output can trigger
  // another Stop event; stop_hook_active is absent from Copilot's payload,
  // so this only ever short-circuits Claude Code.
  if (payload.stop_hook_active) return;

  const cwd = payload.cwd;
  if (!cwd || !(await isGitWorkTree(cwd))) return;
  if (!(await hasUncommittedChanges(cwd))) return;

  const pipelineWorkerDir = join(cwd, '.pipeline-worker');
  if (existsSync(join(pipelineWorkerDir, 'run.lock'))) return; // a run is already in flight; let it finish

  mkdirSync(pipelineWorkerDir, { recursive: true });
  const logPath = join(pipelineWorkerDir, `hook-run-${Date.now()}.log`);
  const spawned = await spawnDetached(cwd, logPath);
  if (spawned) emit(`pipeline-worker: kicked off in the background — see ${logPath}`);
}

main().catch(() => {
  // A hook that crashes the agent's turn over a best-effort background
  // trigger would be worse than silently skipping it.
});
