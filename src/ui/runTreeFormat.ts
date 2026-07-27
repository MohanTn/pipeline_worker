/**
 * Pure Line[]-producing tree layout, shared by the plain-CLI TreeRenderer
 * (ui/treeRenderer.ts) and the TUI's live run screen
 * (ui/tui/views/runDashboard.ts). Ported from what used to be TreeRenderer's
 * private row/branch/figures/header methods, with one change: instead of
 * building an already-colored ANSI string, every function here returns a Line
 * (styled Segments) so a caller decides how to paint it — TreeRenderer via
 * ui/tui/line.js's renderLine(), RunDashboardView by handing the Line
 * straight to the TUI's own paint loop.
 *
 * The row-building budget math (figures truncated to their own room first, so
 * a long detail can never crowd the timing/attempt figures off the right
 * edge) is preserved exactly — see test/treeRenderer.test.ts's narrow-terminal
 * cases, which exercise this module indirectly through TreeRenderer.
 */

import { formatElapsed, formatAttempt } from './renderer.js';
import { formatTokens, formatUsageInline } from './format.js';
import { truncateToWidth } from './steps.js';
import type { MochaRole } from './theme.js';
import { seg, type Line } from './tui/line.js';
import type { RunStatus, RunTree, StepNode, TreeRow } from './runTree.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A collapsed run of finished rows, produced by fitToHeight when the tree outgrows the screen. */
export interface ElisionRow {
  summary: string;
  depth: number;
}

export type DisplayRow = TreeRow | ElisionRow;

function isElision(row: DisplayRow): row is ElisionRow {
  return 'summary' in row;
}

function isFinished(node: StepNode): boolean {
  return node.status === 'done' || node.status === 'skipped';
}

/** True when this subtree holds nothing the user still needs to see individually. */
function subtreeFinished(node: StepNode): boolean {
  return isFinished(node) && node.children.every(subtreeFinished);
}

/**
 * Elides rows until header + rows fit in `maxRows`, keeping what the user
 * actually watches: the running/failed/pending steps. Two passes, both
 * deterministic (pure function, unit-tested directly):
 *
 * 1. collapse each parent's leading finished children (a long fix-attempt
 *    history) into one `… ✓ N earlier attempts` row, keeping the last
 *    finished child for context;
 * 2. collapse leading fully-finished top-level steps into `… ✓ N earlier
 *    steps`.
 *
 * If the tree still doesn't fit (tiny terminal), keep the tail — the newest
 * rows are the live ones.
 */
export function fitToHeight(rows: TreeRow[], maxRows: number): DisplayRow[] {
  const budget = Math.max(1, maxRows - 1); // header takes one row
  if (rows.length <= budget) return rows;

  let display: DisplayRow[] = [...rows];

  // Walks runs of consecutive rows matching `candidate` at the same depth
  // and collapses each run (if longer than 2) down to a summary line plus
  // its final row, so the most recent item of a run stays visible for context.
  const collapseRuns = (candidate: (row: TreeRow) => boolean, label: (n: number, depth: number) => string): void => {
    const next: DisplayRow[] = [];
    let run: TreeRow[] = [];
    const flush = (): void => {
      if (run.length > 2) {
        const collapsed = run.slice(0, -1);
        next.push({ summary: label(collapsed.length, run[0].depth), depth: run[0].depth });
        next.push(run[run.length - 1]);
      } else {
        next.push(...run);
      }
      run = [];
    };
    for (const row of display) {
      if (!isElision(row) && candidate(row) && (run.length === 0 || run[0].depth === row.depth)) {
        run.push(row);
      } else {
        flush();
        next.push(row);
      }
    }
    flush();
    display = next;
  };

  collapseRuns(
    (row) => row.depth > 0 && isFinished(row.node) && row.node.children.length === 0,
    (n) => `… ${n} earlier attempts`,
  );
  if (display.length <= budget) return display;

  collapseRuns(
    (row) => row.depth === 0 && subtreeFinished(row.node),
    (n) => `… ${n} earlier steps`,
  );
  if (display.length <= budget) return display;

  // Last resort: keep the newest rows (the live tail).
  return display.slice(display.length - budget);
}

/** Glyph + color for a step's status column; `frame` animates the running spinner. */
export function statusGlyph(node: StepNode, frame: number): { glyph: string; role: MochaRole } {
  switch (node.status) {
    case 'done':
      return { glyph: '✓', role: 'green' };
    case 'failed':
      return { glyph: '✗', role: 'red' };
    case 'running':
      return { glyph: SPINNER_FRAMES[frame % SPINNER_FRAMES.length], role: 'sky' };
    case 'skipped':
      return { glyph: '–', role: 'overlay1' };
    default:
      return { glyph: '○', role: 'overlay1' };
  }
}

/** Right-hand figures: 'attempt 2/5 · in 98.5k (92k cached) · out 3.2k · 3.2s' — whichever are known, with the plain total standing in when no split was reported. */
export function figuresFor(node: StepNode): string {
  const parts: string[] = [];
  const attempt = formatAttempt(node);
  if (attempt) parts.push(attempt);
  const split = node.usage ? formatUsageInline(node.usage) : '';
  if (split) parts.push(split);
  else if (node.tokens !== undefined) parts.push(formatTokens(node.tokens));
  if (node.durationMs !== undefined) parts.push(formatElapsed(node.durationMs));
  else if (node.status === 'running' && node.startedAt !== undefined) parts.push(formatElapsed(Date.now() - node.startedAt));
  return parts.join(' · ');
}

function branchPrefix(row: TreeRow): string {
  let prefix = '';
  for (let d = 0; d < row.depth; d++) prefix += row.isLast[d] ? '   ' : '│  ';
  prefix += row.isLast[row.depth] ? '└─ ' : '├─ ';
  return prefix;
}

function headerLine(tree: RunTree, status: RunStatus, columns: number): Line {
  const parts = ['pipeline-worker', tree.header.title];
  if (tree.header.worktreeShortId) parts.push(`worktree ${tree.header.worktreeShortId}`);
  parts.push(status);
  const total = tree.totalTokens();
  if (total > 0) parts.push(formatTokens(total));
  return [seg(truncateToWidth(parts.join(' · '), columns), { bold: true })];
}

function rowLine(row: DisplayRow, labelWidth: number, columns: number, frame: number): Line {
  if (isElision(row)) {
    const indent = '   '.repeat(row.depth + 1);
    return [seg(truncateToWidth(`${indent}${row.summary}`, columns), { role: 'overlay1' })];
  }
  const { node } = row;
  const { glyph, role } = statusGlyph(node, frame);
  const prefix = branchPrefix(row);
  const figures = figuresFor(node);
  // Compose the visible text first and truncate it, then colorize — figures
  // are truncated to the row's own room first, so a narrow terminal can't
  // overflow via the right-hand column; the body gets what's left.
  const body = `${node.label.padEnd(labelWidth)}  ${node.detail}`;
  const room = Math.max(0, columns - prefix.length - 2); // glyph + space
  const figuresPart = figures && room > 0 ? truncateToWidth(`  ${figures}`, room) : '';
  const bodyRoom = room - figuresPart.length;
  const text = `${bodyRoom > 0 ? truncateToWidth(body, bodyRoom) : ''}${figuresPart}`;
  const dimRow = node.status === 'skipped' || node.status === 'pending';
  return [seg(prefix), seg(glyph, { role }), seg(` ${text}`, dimRow ? { role: 'overlay1' } : {})];
}

/** The whole frame — header line plus every (possibly elided) tree row — as Line[], ready for any Line-based painter. */
export function buildTreeLines(tree: RunTree, status: RunStatus, frame: number, maxRows: number, columns: number): Line[] {
  const rows = fitToHeight(tree.flatten(), maxRows);
  const labelWidth = Math.max(0, ...rows.map((r) => (isElision(r) ? 0 : r.node.label.length)));
  return [headerLine(tree, status, columns), ...rows.map((row) => rowLine(row, labelWidth, columns, frame))];
}
