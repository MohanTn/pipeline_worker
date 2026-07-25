/**
 * Human-facing rendering for `pipeline-worker sessions` — lists and inspects
 * runs persisted under .pipeline-worker/state/, mirroring the emoji/color
 * narration style ui/steps.ts uses for a live run.
 */

import { styleText } from 'node:util';
import type { RunSession } from '../state/runState.js';
import type { RunPhase } from '../types.js';
import { formatTokens } from './format.js';
import { mocha, type MochaRole } from './theme.js';

const PHASE_COLOR: Record<RunPhase, MochaRole> = {
  diff: 'overlay1',
  intent: 'overlay1',
  checks: 'sky',
  mr: 'sky',
  watch: 'yellow',
  done: 'green',
  escalated: 'red',
};

function formatPhase(phase: RunPhase): string {
  return mocha(PHASE_COLOR[phase], phase.padEnd(9));
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

/** '-' when the run's adapter never reported usage (pi/copilot, or a pre-token-accounting state file) — absence means unknown, never zero. */
function formatTokensColumn(totalTokens: number | undefined): string {
  return (totalTokens !== undefined ? formatTokens(totalTokens) : '-').padEnd(9);
}

function formatSessionRow(session: RunSession): string {
  const { state } = session;
  const branch = formatBranchColumn(state.branch);
  const mr = formatMrColumn(state.mrIid);
  const attempts = `${String(state.ciFixAttempt).padEnd(6)} ${String(state.conflictAttempt).padEnd(8)}`;
  return `${branch} ${formatPhase(state.phase)} ${attempts} ${mr.padEnd(7)} ${formatTokensColumn(state.totalTokens)} ${formatTimestamp(state.updatedAt)}`;
}

/** `pipeline-worker sessions` with no --branch: one line per persisted run, most recently updated first. */
export function printSessionList(sessions: RunSession[]): void {
  if (sessions.length === 0) {
    console.log('pipeline-worker: no sessions found in this repo (.pipeline-worker/state/ is empty).');
    return;
  }
  console.log(styleText('bold', `${'BRANCH'.padEnd(40)} ${'PHASE'.padEnd(9)} CI-FIX CONFLICT MR/PR   ${'TOKENS'.padEnd(9)} UPDATED`));
  for (const session of sessions) {
    console.log(formatSessionRow(session));
  }
  console.log();
  console.log(mocha('overlay1', "Run `pipeline-worker sessions --branch <name>` for a run's full timeline."));
}

const LEVEL_ICON: Record<'info' | 'error', string> = { info: 'ℹ️ ', error: '❌' };

function formatOptionalMetaParts(state: RunSession['state']): { mrPart: string; pipelinePart: string } {
  return {
    mrPart: state.mrIid !== undefined ? `  mr/pr: #${state.mrIid}` : '',
    pipelinePart: state.pipelineId !== undefined ? `  pipeline: ${state.pipelineId}` : '',
  };
}

function formatHistoryEntry(entry: NonNullable<RunSession['state']['history']>[number]): string {
  const message = entry.level === 'error' ? mocha('red', entry.message) : entry.message;
  const tokensPart = entry.tokens !== undefined ? ` ${mocha('overlay1', `· ${formatTokens(entry.tokens)}`)}` : '';
  return `  ${LEVEL_ICON[entry.level]} ${mocha('overlay1', formatTimestamp(entry.at))} ${mocha('overlay1', `[${entry.phase}]`)} ${message}${tokensPart}`;
}

/** `pipeline-worker sessions --branch <name>`: one run's metadata plus its full step-by-step history. */
export function printSessionDetail(session: RunSession): void {
  const { state } = session;
  const { mrPart, pipelinePart } = formatOptionalMetaParts(state);

  console.log(styleText('bold', `Session: ${state.branch}`));
  console.log(mocha('overlay1', `  target: ${state.targetBranch}`));
  console.log(mocha('overlay1', `  worktree: ${state.worktreePath}`));
  const tokensPart = state.totalTokens !== undefined ? `  tokens: ${formatTokens(state.totalTokens)}` : '';
  console.log(
    mocha('overlay1', `  phase: ${state.phase}  ci-fix: ${state.ciFixAttempt}  conflict: ${state.conflictAttempt}${mrPart}${pipelinePart}${tokensPart}`),
  );
  console.log(mocha('overlay1', `  started: ${formatTimestamp(state.startedAt)}  updated: ${formatTimestamp(state.updatedAt)}`));

  const history = state.history ?? [];
  if (history.length === 0) {
    console.log();
    console.log(mocha('overlay1', "  (no step history recorded for this run — it predates pipeline-worker's session history feature)"));
    return;
  }

  console.log();
  console.log(styleText('bold', 'Timeline:'));
  for (const entry of history) {
    console.log(formatHistoryEntry(entry));
  }
}
