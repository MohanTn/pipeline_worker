/**
 * Rendering strategies for the run tree (ui/runTree.ts). Two implementations:
 *
 * - LineRenderer (here): append-only scrolled lines — used when stdout is not
 *   a TTY (CI logs, piped output) or when PIPELINE_WORKER_PLAIN_OUTPUT=true.
 *   Zero cursor movement; colors are applied via node:util's styleText, which
 *   already disables itself on non-color streams.
 * - TreeRenderer (ui/treeRenderer.ts): the live TTY dashboard with a pinned
 *   bottom region.
 *
 * Renderers receive fine-grained TreeEvents from the facade (ui/steps.ts) and
 * may ignore the granularity (TreeRenderer just repaints). log() is the one
 * channel for freeform text — notes, agent output, warnings — so a renderer
 * that owns the screen can route it above its pinned region.
 */

import { styleText } from 'node:util';
import { formatTokens } from './format.js';
import type { RunStatus, RunTree, StepNode, TreeEvent } from './runTree.js';

export interface Renderer {
  onEvent(event: TreeEvent, tree: RunTree): void;
  /** Freeform text outside the tree: notes, agent output, warnings. */
  log(text: string): void;
  /** Final paint for the run's terminal status; must leave the terminal usable. */
  stop(status: RunStatus, detail: string | undefined, tree: RunTree): void;
}

export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The parenthesized tail of a finished step: '(3.2s · 1.9k tok)', or '' when neither figure is known. */
export function formatStepFigures(node: StepNode): string {
  const parts: string[] = [];
  if (node.durationMs !== undefined) parts.push(formatElapsed(node.durationMs));
  if (node.tokens !== undefined) parts.push(formatTokens(node.tokens));
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}

/** 'attempt N/M' when both sides are known, else ''. */
export function formatAttempt(node: StepNode): string {
  return node.attempt !== undefined && node.maxAttempts !== undefined ? `attempt ${node.attempt}/${node.maxAttempts}` : '';
}

const FINISH_GLYPH: Record<'done' | 'failed' | 'skipped', string> = { done: '✓', failed: '✗', skipped: '–' };
const FINISH_COLOR: Record<'done' | 'failed' | 'skipped', 'green' | 'red' | 'dim'> = { done: 'green', failed: 'red', skipped: 'dim' };

const FINAL_LINE: Record<Exclude<RunStatus, 'running'>, string> = {
  done: '🎉 Done',
  failed: '✗ Run failed',
  escalated: '🚨 Stopped for human review',
  interrupted: '⏹ Interrupted',
};

/**
 * Append-only narration, one block per step: a bold start line with the
 * detail beneath it, phase changes as indented arrows, and a colored
 * ✓/✗/– settle line with duration and token figures. Mirrors the shape of
 * the old numbered-stage output so non-TTY logs stay diffable and greppable.
 */
export class LineRenderer implements Renderer {
  // The default defers the console.log lookup to call time (not construction),
  // so a test — or the TreeRenderer's console interception — that swaps
  // console.log after this renderer exists still receives the output.
  constructor(private readonly out: (line: string) => void = (line) => console.log(line)) {}

  onEvent(event: TreeEvent): void {
    if (event.kind === 'start') {
      const attempt = formatAttempt(event.node);
      this.out('');
      this.out(styleText(['bold', 'cyan'], `▶ ${event.node.label}${attempt ? ` — ${attempt}` : ''}`));
      if (event.node.detail) this.out(styleText('dim', `  ${event.node.detail}`));
      return;
    }
    if (event.kind === 'update' && event.node.status === 'running' && event.node.detail) {
      this.out(styleText('dim', `  → ${event.node.detail}`));
      return;
    }
    if (event.kind === 'finish') {
      const status = event.node.status as 'done' | 'failed' | 'skipped';
      const glyph = FINISH_GLYPH[status] ?? '?';
      const skipTail = status === 'skipped' ? ' (skipped)' : '';
      const detail = event.node.detail ? ` — ${event.node.detail}` : '';
      this.out(styleText(FINISH_COLOR[status] ?? 'dim', `${glyph} ${event.node.label}${skipTail}${detail}${formatStepFigures(event.node)}`));
    }
    // 'add', 'tokens', and 'header' need no line of their own: tokens show on
    // the finish line, and header changes only matter to the live dashboard.
  }

  log(text: string): void {
    this.out(text);
  }

  stop(status: RunStatus, detail: string | undefined, tree: RunTree): void {
    if (status === 'running') return;
    const total = tree.totalTokens();
    const tokensPart = total > 0 ? ` (${formatTokens(total)})` : '';
    this.out('');
    this.out(styleText('bold', `${FINAL_LINE[status]}${tokensPart}`));
    if (detail) this.out(styleText('dim', `  ${detail}`));
  }
}
