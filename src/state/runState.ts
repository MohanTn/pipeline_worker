/**
 * Persists RunState at <repoRoot>/.pipeline-worker/state/<branch>.json so `pipeline-worker
 * resume` can recover after a crash mid-poll. Read/write never throw — a
 * lost state file only degrades `resume`/`status`, it never corrupts GitLab
 * state (the forge client's findExistingMr is the real idempotency guard).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunState } from '../types.js';

function statePath(repoRoot: string, branch: string): string {
  const safeName = branch.replace(/\//g, '_');
  return join(repoRoot, '.pipeline-worker', 'state', `${safeName}.json`);
}

export function saveRunState(repoRoot: string, state: RunState): void {
  try {
    const path = statePath(repoRoot, state.branch);
    mkdirSync(join(repoRoot, '.pipeline-worker', 'state'), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to persist run state for branch ${state.branch}: ${message}`);
  }
}

export function loadRunState(repoRoot: string, branch: string): RunState | undefined {
  const path = statePath(repoRoot, branch);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RunState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to read run state at ${path}: ${message}`);
    return undefined;
  }
}
