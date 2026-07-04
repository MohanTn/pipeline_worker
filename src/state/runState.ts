/**
 * Persists RunState at <repoRoot>/.pipeline-worker/state/<branch>.json so `pipeline-worker
 * resume` can recover after a crash mid-poll. Read/write never throw — a
 * lost state file only degrades `resume`/`status`, it never corrupts GitLab
 * state (the forge client's findExistingMr is the real idempotency guard).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RunState } from '../types.js';

/** Caps state.history so a long-running CI-fix loop can't grow the state file unboundedly. */
const MAX_HISTORY_ENTRIES = 200;

function stateDir(repoRoot: string): string {
  return join(repoRoot, '.pipeline-worker', 'state');
}

function statePath(repoRoot: string, branch: string): string {
  const safeName = branch.replace(/\//g, '_');
  return join(stateDir(repoRoot), `${safeName}.json`);
}

export function saveRunState(repoRoot: string, state: RunState): void {
  try {
    const dir = stateDir(repoRoot);
    mkdirSync(dir, { recursive: true });
    const path = statePath(repoRoot, state.branch);
    // Write to a temp file in the same directory, then rename over the real
    // path. A same-directory rename is atomic on POSIX and Windows, so a
    // process kill mid-write can never leave a truncated/corrupt state file
    // at `path` — a reader always sees either the previous complete write or
    // the new one, never a partial one.
    const tmpPath = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmpPath, path);
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

/**
 * Appends a timestamped entry to state.history and persists it — this is the
 * narration `pipeline-worker sessions --branch <name>` renders. Mutates
 * `state` in place, matching how saveRunState is already called throughout
 * orchestrate.ts/watchPipeline.ts.
 */
export function recordEvent(repoRoot: string, state: RunState, message: string, level: 'info' | 'error' = 'info'): void {
  const now = new Date().toISOString();
  state.startedAt ??= now;
  state.updatedAt = now;
  const history = [...(state.history ?? []), { at: now, phase: state.phase, level, message }];
  state.history = history.length > MAX_HISTORY_ENTRIES ? history.slice(history.length - MAX_HISTORY_ENTRIES) : history;
  saveRunState(repoRoot, state);
}

export interface RunSession {
  branch: string;
  state: RunState;
}

/**
 * Lists every persisted run in this repo (one per state file), most
 * recently updated first. A corrupt/partial state file is skipped rather
 * than failing the whole listing — `pipeline-worker sessions` should show
 * what it can even if one run's file is damaged.
 */
export function listRunStates(repoRoot: string): RunSession[] {
  const dir = stateDir(repoRoot);
  if (!existsSync(dir)) return [];
  const sessions: RunSession[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const state = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as RunState;
      sessions.push({ branch: state.branch, state });
    } catch {
      continue;
    }
  }
  return sessions.sort((a, b) => (b.state.updatedAt ?? '').localeCompare(a.state.updatedAt ?? ''));
}
