/**
 * The workflow's one door to the terminal: module-level functions the
 * workflow code calls by step id, backed by a RunTree (the data model) and a
 * Renderer (LineRenderer for non-TTY/plain output, TreeRenderer for the live
 * TTY dashboard). Workflow code never touches process.stdout itself — see
 * CLAUDE.md's terminal-output discipline.
 *
 * The facade is safe to use without beginRun() (unit tests exercise workflow
 * helpers directly): the first call lazily creates an empty tree with a
 * LineRenderer, and unknown step ids materialize as top-level nodes instead
 * of throwing — the UI must never kill the run.
 */

import { styleText } from 'node:util';
import { RunTree, type RunStatus, type StepSeed } from './runTree.js';
import { LineRenderer, type Renderer } from './renderer.js';
import type { RiskLevel } from '../types.js';
import type { AgentInvokeResult } from '../agent/types.js';

const RISK_COLOR: Record<RiskLevel, 'green' | 'yellow' | 'red'> = { low: 'green', medium: 'yellow', high: 'red' };

interface ActiveRun {
  tree: RunTree;
  renderer: Renderer;
  ended: boolean;
}

let active: ActiveRun | undefined;
/** The most recently started step — where noteSession attributes an agent turn's tokens. */
let lastStepId: string | undefined;

/**
 * Keeps a spinner/tree redraw to a single physical row. Without this, a line
 * longer than the terminal's column count auto-wraps, and cursor-based
 * erasing only rewinds the rows it knows about — not the wrapped
 * continuation — so each frame appends garbage instead of animating in place.
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0 || text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}…`;
}

function createRenderer(): Renderer {
  // TreeRenderer (the live TTY dashboard) plugs in here; until it exists,
  // every mode gets the append-only LineRenderer.
  return new LineRenderer();
}

function ensureActive(): ActiveRun {
  if (!active) {
    const renderer = createRenderer();
    const tree = new RunTree([], { title: 'run' }, (event) => renderer.onEvent(event, tree));
    active = { tree, renderer, ended: false };
  }
  return active;
}

/** Starts a new run display. Replaces any previous run's tree (each CLI invocation begins at most one). */
export function beginRun(skeleton: StepSeed[], header: { title: string; worktreeShortId?: string }): void {
  const renderer = createRenderer();
  const tree = new RunTree(skeleton, header, (event) => renderer.onEvent(event, tree));
  active = { tree, renderer, ended: false };
  lastStepId = undefined;
}

/**
 * Settles the run display into its terminal status. Idempotent: only the
 * first call paints, so error paths can call endRun('failed') defensively
 * without stomping an earlier, more specific verdict.
 */
export function endRun(status: Exclude<RunStatus, 'running'>, detail?: string): void {
  const run = ensureActive();
  if (run.ended) return;
  run.ended = true;
  run.tree.setHeader({ status });
  run.renderer.stop(status, detail, run.tree);
}

/** Adds a step that wasn't in the skeleton — the watch loop's fix/rebase attempts, conflict resolution, squash. */
export function addDynamicStep(parentId: string | undefined, id: string, label: string, detail = ''): void {
  ensureActive().tree.add(parentId, { id, label, detail });
}

/** Marks a step running without tying it to a single task closure — for steps whose phases span several calls (see runPhase). */
export function startStep(id: string, patch: { detail?: string; attempt?: number; maxAttempts?: number } = {}): void {
  lastStepId = id;
  ensureActive().tree.start(id, patch);
}

export function finishStep(id: string, status: 'done' | 'failed' = 'done', patch: { detail?: string } = {}): void {
  ensureActive().tree.finish(id, status, patch);
}

export function updateStep(id: string, patch: { detail?: string; attempt?: number; maxAttempts?: number }): void {
  ensureActive().tree.update(id, patch);
}

/** Announces a step that did not run this time, and why — a skipped stage stays visible instead of silently vanishing (which reads as a bug, not a choice). */
export function skipStep(id: string, reason: string): void {
  ensureActive().tree.finish(id, 'skipped', { detail: reason });
}

/** Runs one step to completion: running → done, or running → failed + rethrow. */
export async function runStep<T>(id: string, detail: string, task: () => Promise<T>): Promise<T> {
  const run = ensureActive();
  lastStepId = id;
  run.tree.start(id, { detail });
  try {
    const result = await task();
    run.tree.finish(id, 'done');
    return result;
  } catch (error) {
    run.tree.finish(id, 'failed');
    throw error;
  }
}

/**
 * Runs one phase of an already-running step (a fix attempt's agent turn,
 * local verify, push, ...), mutating the step's detail rather than creating
 * grandchildren — the tree stays one row per attempt, as the dashboard
 * renders it. Failure marks the whole step failed and rethrows; success
 * leaves it running for the next phase (the caller finishes it).
 */
export async function runPhase<T>(id: string, detail: string, task: () => Promise<T>): Promise<T> {
  const run = ensureActive();
  const node = run.tree.get(id);
  if (!node || node.status !== 'running') {
    startStep(id, { detail });
  } else {
    run.tree.update(id, { detail });
  }
  try {
    return await task();
  } catch (error) {
    run.tree.finish(id, 'failed');
    throw error;
  }
}

/** Updates the header line: the run's display name (once intent names the branch) and the worktree short id. */
export function setRunHeader(patch: { title?: string; worktreeShortId?: string }): void {
  ensureActive().tree.setHeader(patch);
}

/** Folds a resumed run's persisted token total into the header figure, so the dashboard shows the whole run's spend, not just this process's share. */
export function seedRunTokens(tokens: number): void {
  ensureActive().tree.seedTokens(tokens);
}

/** A bold one-off announcement outside any step (adopting a branch, pipeline failed, ...). */
export function announce(text: string, detail?: string): void {
  const run = ensureActive();
  run.renderer.log('');
  run.renderer.log(styleText('bold', text));
  if (detail) run.renderer.log(styleText('dim', `  ${detail}`));
}

/**
 * An indented supplementary detail line under the current step (e.g. an
 * agent's summary, a result). Input is freeform (agent output, forge data)
 * with no single-line guarantee, so collapse any embedded newlines —
 * otherwise a multi-line value would break out of the "one dim line" format.
 */
export function note(text: string): void {
  ensureActive().renderer.log(styleText('dim', `  ${text.replace(/\s*\n\s*/g, ' ')}`));
}

/** Like note(), but colors the text by risk level (green/yellow/red for low/medium/high). */
export function noteRisk(risk: RiskLevel, reason: string): void {
  ensureActive().renderer.log(styleText('dim', '  ') + styleText(RISK_COLOR[risk], `risk: ${risk} — ${reason.replace(/\s*\n\s*/g, ' ')}`));
}

/**
 * Reports which agent CLI session handled a turn, how long it took, and the
 * worktree it ran in, so a user who wants to see how a conflict was resolved
 * or a CI failure was fixed can look it up afterwards (`claude --resume <id>`
 * or, for Copilot, `copilot --resume <id>` — see agent/copilot.ts on why that
 * id is one we assigned rather than one the CLI reported). Session history is
 * scoped to the working directory the CLI ran in, so `--resume` only finds
 * the session when run from that same worktree path — printing the path lets
 * the user `cd` there first. A no-op when the adapter didn't return a
 * sessionId, which keeps this safe to call unconditionally.
 *
 * Also attributes the turn's token spend (when the adapter reported any) to
 * the step that ran it, which is what feeds the per-step and header token
 * figures on the dashboard.
 */
export function noteSession(result: AgentInvokeResult, worktreePath: string): void {
  if (result.usage?.totalTokens !== undefined && lastStepId !== undefined) {
    ensureActive().tree.addTokens(lastStepId, result.usage.totalTokens);
  }
  if (!result.sessionId) return;
  const duration = result.durationMs !== undefined ? ` — ${(result.durationMs / 1000).toFixed(1)}s` : '';
  note(`agent session: ${result.sessionId}${duration} — cd ${worktreePath} to resume it there`);
}

/** Prints an agent's response (truncated) followed by its resumable session info — the shared tail of every conflict/CI-fix agent invocation. */
export function reportAgentInvocation(result: AgentInvokeResult, worktreePath: string): void {
  const text = result.text;
  note(`agent: ${text.slice(0, 300).trim()}${text.length > 300 ? '…' : ''}`);
  noteSession(result, worktreePath);
}
