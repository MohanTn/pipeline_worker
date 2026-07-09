/**
 * The live TTY dashboard: a pinned bottom region holding the run header and
 * the step tree, repainted in place, with freeform log lines (notes, agent
 * output, stray console writes) scrolling into the terminal's scrollback
 * ABOVE the region — the same strategy ora/listr2 use, hand-rolled to keep
 * the dependency count at zero.
 *
 *   pipeline-worker · fix-login-redirect · worktree a91f · running · 9.4k tok
 *   ├─ ✓ capture    staged + unstaged diff                                0.4s
 *   ├─ ● ci-watch   pipeline #8123: fixing                 attempt 2/5 · 4.4k tok
 *   └─ ○ merge      auto-merge + sync local main
 *
 * Invariants that keep the redraw exact:
 * - Every painted line is pre-truncated to the terminal width, so no line
 *   can wrap; `renderedLines` therefore always equals the physical rows the
 *   region occupies, and one `ESC[{n}A CR ESC[J` erases exactly the region.
 * - While attached, console.log/error are intercepted and routed through
 *   log(), so nothing can print into the middle of the region (CLAUDE.md's
 *   terminal-output discipline keeps direct process.stdout writers out of
 *   the rest of the codebase).
 * - The cursor is hidden on attach and restored on stop AND on process exit
 *   (the 'exit' hook only does a sync write, which is allowed there), so a
 *   ctrl-C mid-frame never leaves a cursorless terminal.
 */

import { styleText } from 'node:util';
import { truncateToWidth } from './steps.js';
import { formatTokens } from './format.js';
import { formatElapsed, formatAttempt, type Renderer } from './renderer.js';
import type { RunStatus, RunTree, StepNode, TreeEvent, TreeRow } from './runTree.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PAINT_INTERVAL_MS = 80;
const DEFAULT_COLUMNS = 80;

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/** The slice of a TTY WriteStream the renderer needs — injectable so tests drive a fake with fixed geometry. */
export interface OutStream {
  write(text: string): void;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): void;
  off?(event: 'resize', listener: () => void): void;
}

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

export class TreeRenderer implements Renderer {
  private tree: RunTree | undefined;
  private renderedLines = 0;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly originalConsole = { log: console.log, error: console.error, warn: console.warn };
  private readonly onResize = (): void => {
    // Post-reflow, the terminal may have re-wrapped the old region in ways
    // cursor math can't undo reliably; abandon it (one junk block stays in
    // scrollback — the deliberate trade-off) and paint fresh.
    this.out.write('\n');
    this.renderedLines = 0;
    this.paint();
  };
  private readonly restoreCursorOnExit = (): void => {
    if (!this.stopped) this.out.write(SHOW_CURSOR);
  };

  constructor(private readonly out: OutStream = process.stdout) {}

  private columns(): number {
    return this.out.columns ?? DEFAULT_COLUMNS;
  }

  /**
   * Repaints immediately on every tree mutation — a step finishing or a
   * token count changing must show up right away, not on the next spinner
   * tick. The interval timer (attach()) exists only to keep the spinner
   * glyph and the running step's elapsed-time counter animating during long
   * stretches with no tree events at all (a multi-minute CI poll).
   */
  onEvent(event: TreeEvent, tree: RunTree): void {
    if (this.tree === undefined) this.attach(tree);
    void event;
    this.paint();
  }

  private attach(tree: RunTree): void {
    this.tree = tree;
    this.out.write(HIDE_CURSOR);
    process.once('exit', this.restoreCursorOnExit);
    this.out.on?.('resize', this.onResize);
    // Route anything that would print mid-region through log() instead.
    console.log = (...args: unknown[]) => this.log(args.map(String).join(' '));
    console.error = (...args: unknown[]) => this.log(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => this.log(args.map(String).join(' '));
    // unref() so a settled run's process never lingers on the spinner timer.
    this.timer = setInterval(() => this.paint(), PAINT_INTERVAL_MS);
    this.timer.unref?.();
  }

  private eraseRegion(): void {
    if (this.renderedLines > 0) {
      this.out.write(`\x1b[${this.renderedLines}A\r\x1b[J`);
      this.renderedLines = 0;
    }
  }

  /** Freeform text: erase the region, let the text enter scrollback, repaint beneath it. */
  log(text: string): void {
    this.eraseRegion();
    this.out.write(`${text}\n`);
    if (!this.stopped) this.paint();
  }

  private headerLine(status: RunStatus): string {
    const tree = this.tree!;
    const parts = ['pipeline-worker', tree.header.title];
    if (tree.header.worktreeShortId) parts.push(`worktree ${tree.header.worktreeShortId}`);
    parts.push(status);
    const total = tree.totalTokens();
    if (total > 0) parts.push(formatTokens(total));
    return truncateToWidth(parts.join(' · '), this.columns());
  }

  private statusGlyph(node: StepNode): { glyph: string; color: Parameters<typeof styleText>[0] } {
    switch (node.status) {
      case 'done':
        return { glyph: '✓', color: 'green' };
      case 'failed':
        return { glyph: '✗', color: 'red' };
      case 'running':
        return { glyph: SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length], color: 'cyan' };
      case 'skipped':
        return { glyph: '–', color: 'dim' };
      default:
        return { glyph: '○', color: 'dim' };
    }
  }

  /** Right-hand figures: 'attempt 2/5 · 4.4k tok · 3.2s' — whichever are known. */
  private figures(node: StepNode): string {
    const parts: string[] = [];
    const attempt = formatAttempt(node);
    if (attempt) parts.push(attempt);
    if (node.tokens !== undefined) parts.push(formatTokens(node.tokens));
    if (node.durationMs !== undefined) parts.push(formatElapsed(node.durationMs));
    else if (node.status === 'running' && node.startedAt !== undefined) parts.push(formatElapsed(Date.now() - node.startedAt));
    return parts.join(' · ');
  }

  private branchPrefix(row: TreeRow): string {
    let prefix = '';
    for (let d = 0; d < row.depth; d++) prefix += row.isLast[d] ? '   ' : '│  ';
    prefix += row.isLast[row.depth] ? '└─ ' : '├─ ';
    return prefix;
  }

  private rowLine(row: DisplayRow, labelWidth: number): string {
    const width = this.columns();
    if (isElision(row)) {
      const indent = '   '.repeat(row.depth + 1);
      return styleText('dim', truncateToWidth(`${indent}${row.summary}`, width));
    }
    const { node } = row;
    const { glyph, color } = this.statusGlyph(node);
    const prefix = this.branchPrefix(row);
    const figures = this.figures(node);
    // Compose the visible text first and truncate it, then colorize the two
    // zones (glyph, rest) — escape codes are zero-width, so wrapping math
    // must run on the plain string.
    const body = `${node.label.padEnd(labelWidth)}  ${node.detail}`;
    const room = width - prefix.length - 2; // glyph + space
    const figuresPart = figures ? `  ${figures}` : '';
    const bodyRoom = Math.max(0, room - figuresPart.length);
    const text = `${truncateToWidth(body, bodyRoom)}${figuresPart}`;
    const dimRow = node.status === 'skipped' || node.status === 'pending';
    return `${prefix}${styleText(color, glyph)} ${dimRow ? styleText('dim', text) : text}`;
  }

  private buildFrame(status: RunStatus): string[] {
    const tree = this.tree!;
    const rows = fitToHeight(tree.flatten(), this.out.rows ?? Number.POSITIVE_INFINITY);
    const labelWidth = Math.max(0, ...rows.map((r) => (isElision(r) ? 0 : r.node.label.length)));
    return [styleText('bold', this.headerLine(status)), ...rows.map((row) => this.rowLine(row, labelWidth))];
  }

  private paint(): void {
    if (!this.tree || this.stopped) return;
    this.frame += 1;
    const lines = this.buildFrame(this.tree.header.status);
    this.eraseRegion();
    this.out.write(`${lines.join('\n')}\n`);
    this.renderedLines = lines.length;
  }

  stop(status: RunStatus, detail: string | undefined, tree: RunTree): void {
    if (this.tree === undefined) this.tree = tree;
    if (this.stopped) return;
    if (this.timer) clearInterval(this.timer);
    // Final frame: repaint with the terminal status so the settled tree stays
    // in scrollback as the run's record, then the detail line beneath it.
    const lines = this.buildFrame(status);
    this.eraseRegion();
    this.out.write(`${lines.join('\n')}\n`);
    if (detail) this.out.write(styleText('dim', `  ${truncateToWidth(detail, this.columns())}`) + '\n');
    this.stopped = true;
    this.renderedLines = 0;
    this.out.write(SHOW_CURSOR);
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    this.out.off?.('resize', this.onResize);
  }
}
