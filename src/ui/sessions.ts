/**
 * Human-facing rendering for `pipeline-worker sessions` — lists and inspects
 * runs persisted under .pipeline-worker/state/, mirroring the emoji/color
 * narration style ui/steps.ts uses for a live run.
 */

import { styleText } from 'node:util';
import type { RunSession } from '../state/runState.js';
import type { RunPhase } from '../types.js';

const PHASE_COLOR: Record<RunPhase, Parameters<typeof styleText>[0]> = {
  diff: 'dim',
  intent: 'dim',
  checks: 'cyan',
  mr: 'cyan',
  watch: 'yellow',
  done: 'green',
  escalated: 'red',
};

function formatPhase(phase: RunPhase): string {
  return styleText(PHASE_COLOR[phase], phase.padEnd(9));
}

function formatTimestamp(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : 'unknown';
}

/** `pipeline-worker sessions` with no --branch: one line per persisted run, most recently updated first. */
export function printSessionList(sessions: RunSession[]): void {
  if (sessions.length === 0) {
    console.log('pipeline-worker: no sessions found in this repo (.pipeline-worker/state/ is empty).');
    return;
  }
  console.log(styleText('bold', `${'BRANCH'.padEnd(40)} ${'PHASE'.padEnd(9)} ATTEMPT  MR/PR   UPDATED`));
  for (const { state } of sessions) {
    const branch = state.branch.length > 40 ? `${state.branch.slice(0, 37)}...` : state.branch.padEnd(40);
    const mr = state.mrIid !== undefined ? `#${state.mrIid}` : '-';
    console.log(`${branch} ${formatPhase(state.phase)} ${String(state.attempt).padEnd(8)} ${mr.padEnd(7)} ${formatTimestamp(state.updatedAt)}`);
  }
  console.log();
  console.log(styleText('dim', "Run `pipeline-worker sessions --branch <name>` for a run's full timeline."));
}

const LEVEL_ICON: Record<'info' | 'error', string> = { info: 'ℹ️ ', error: '❌' };

/** `pipeline-worker sessions --branch <name>`: one run's metadata plus its full step-by-step history. */
export function printSessionDetail(session: RunSession): void {
  const { state } = session;
  const mrPart = state.mrIid !== undefined ? `  mr/pr: #${state.mrIid}` : '';
  const pipelinePart = state.pipelineId !== undefined ? `  pipeline: ${state.pipelineId}` : '';

  console.log(styleText('bold', `Session: ${state.branch}`));
  console.log(styleText('dim', `  target: ${state.targetBranch}`));
  console.log(styleText('dim', `  worktree: ${state.worktreePath}`));
  console.log(styleText('dim', `  phase: ${state.phase}  attempt: ${state.attempt}${mrPart}${pipelinePart}`));
  console.log(styleText('dim', `  started: ${formatTimestamp(state.startedAt)}  updated: ${formatTimestamp(state.updatedAt)}`));

  const history = state.history ?? [];
  if (history.length === 0) {
    console.log();
    console.log(styleText('dim', "  (no step history recorded for this run — it predates pipeline-worker's session history feature)"));
    return;
  }

  console.log();
  console.log(styleText('bold', 'Timeline:'));
  for (const entry of history) {
    const message = entry.level === 'error' ? styleText('red', entry.message) : entry.message;
    console.log(`  ${LEVEL_ICON[entry.level]} ${styleText('dim', formatTimestamp(entry.at))} ${styleText('dim', `[${entry.phase}]`)} ${message}`);
  }
}
