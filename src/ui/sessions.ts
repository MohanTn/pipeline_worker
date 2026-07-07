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

function formatBranchColumn(branch: string): string {
  return branch.length > 40 ? `${branch.slice(0, 37)}...` : branch.padEnd(40);
}

function formatMrColumn(mrIid: number | undefined): string {
  return mrIid !== undefined ? `#${mrIid}` : '-';
}

function formatSessionRow(session: RunSession): string {
  const { state } = session;
  const branch = formatBranchColumn(state.branch);
  const mr = formatMrColumn(state.mrIid);
  const attempts = `${String(state.ciFixAttempt).padEnd(6)} ${String(state.conflictAttempt).padEnd(8)}`;
  return `${branch} ${formatPhase(state.phase)} ${attempts} ${mr.padEnd(7)} ${formatTimestamp(state.updatedAt)}`;
}

/** `pipeline-worker sessions` with no --branch: one line per persisted run, most recently updated first. */
export function printSessionList(sessions: RunSession[]): void {
  if (sessions.length === 0) {
    console.log('pipeline-worker: no sessions found in this repo (.pipeline-worker/state/ is empty).');
    return;
  }
  console.log(styleText('bold', `${'BRANCH'.padEnd(40)} ${'PHASE'.padEnd(9)} CI-FIX CONFLICT MR/PR   UPDATED`));
  for (const session of sessions) {
    console.log(formatSessionRow(session));
  }
  console.log();
  console.log(styleText('dim', "Run `pipeline-worker sessions --branch <name>` for a run's full timeline."));
}

const LEVEL_ICON: Record<'info' | 'error', string> = { info: 'ℹ️ ', error: '❌' };

function formatOptionalMetaParts(state: RunSession['state']): { mrPart: string; pipelinePart: string } {
  return {
    mrPart: state.mrIid !== undefined ? `  mr/pr: #${state.mrIid}` : '',
    pipelinePart: state.pipelineId !== undefined ? `  pipeline: ${state.pipelineId}` : '',
  };
}

function formatHistoryEntry(entry: NonNullable<RunSession['state']['history']>[number]): string {
  const message = entry.level === 'error' ? styleText('red', entry.message) : entry.message;
  return `  ${LEVEL_ICON[entry.level]} ${styleText('dim', formatTimestamp(entry.at))} ${styleText('dim', `[${entry.phase}]`)} ${message}`;
}

/** `pipeline-worker sessions --branch <name>`: one run's metadata plus its full step-by-step history. */
export function printSessionDetail(session: RunSession): void {
  const { state } = session;
  const { mrPart, pipelinePart } = formatOptionalMetaParts(state);

  console.log(styleText('bold', `Session: ${state.branch}`));
  console.log(styleText('dim', `  target: ${state.targetBranch}`));
  console.log(styleText('dim', `  worktree: ${state.worktreePath}`));
  console.log(
    styleText('dim', `  phase: ${state.phase}  ci-fix: ${state.ciFixAttempt}  conflict: ${state.conflictAttempt}${mrPart}${pipelinePart}`),
  );
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
    console.log(formatHistoryEntry(entry));
  }
}
