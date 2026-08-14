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

import { usageFooter } from './format.js';
import type { Renderer } from './renderer.js';
import { mocha } from './theme.js';
import { truncateToWidth } from './steps.js';
import { renderLine } from './tui/line.js';
import { buildTreeLines } from './runTreeFormat.js';
import type { RunStatus, RunTree, TreeEvent } from './runTree.js';

// Row layout (branch glyphs, figures budget, elision) moved to
// runTreeFormat.js so the TUI's live run screen can draw the identical
// frame; re-exported here so existing importers (test/treeRenderer.test.ts)
// don't need to know it moved.
export { fitToHeight, type DisplayRow, type ElisionRow } from './runTreeFormat.js';

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

export class TreeRenderer implements Renderer {
  private tree: RunTree | undefined;
  private renderedLines = 0;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** True while another screen owns the terminal (see pause/resume): no repaint, no console interception. */
  private paused = false;
  /** Notes raised while paused: held here rather than printed over the screen that took the terminal, and flushed by resume(). */
  private readonly pendingLogs: string[] = [];
  private readonly originalConsole = { log: console.log, error: console.error, warn: console.warn };
  // Every painted line is pre-truncated to the terminal width (see the file
  // header), so a resize never changes how many physical rows the region
  // occupies — renderedLines is still accurate. A plain repaint erases the
  // old frame and draws the new one in its place, same as any other event;
  // this used to instead abandon the region and print a fresh block below
  // it, which meant a mouse-drag resize (many resize events in a row) left
  // a stack of stale frames behind, appending rather than replacing.
  private readonly onResize = (): void => {
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
    this.interceptConsole();
    // unref() so a settled run's process never lingers on the spinner timer.
    this.timer = setInterval(() => this.paint(), PAINT_INTERVAL_MS);
    this.timer.unref?.();
  }

  /**
   * Gives the terminal up: erase the pinned region, stop the repaint timer,
   * hand console.log back, and show the cursor — everything attach() did. Any
   * write from here (the alt-screen review picker) would otherwise land in the
   * middle of a region this renderer still believes it owns, and the next
   * paint would erase rows it does not own.
   */
  pause(): void {
    if (this.paused || this.stopped || !this.tree) return;
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.eraseRegion();
    this.restoreConsole();
    this.out.write(SHOW_CURSOR);
  }

  resume(): void {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.out.write(HIDE_CURSOR);
    this.interceptConsole();
    // Whatever was raised while another screen owned the terminal lands in
    // scrollback first, so the repaint below sits beneath it as usual.
    for (const text of this.pendingLogs.splice(0)) this.out.write(`${text}\n`);
    this.timer = setInterval(() => this.paint(), PAINT_INTERVAL_MS);
    this.timer.unref?.();
    this.paint();
  }

  private interceptConsole(): void {
    console.log = (...args: unknown[]) => this.log(args.map(String).join(' '));
    console.error = (...args: unknown[]) => this.log(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => this.log(args.map(String).join(' '));
  }

  private restoreConsole(): void {
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
  }

  private eraseRegion(): void {
    if (this.renderedLines > 0) {
      this.out.write(`\x1b[${this.renderedLines}A\r\x1b[J`);
      this.renderedLines = 0;
    }
  }

  /** Freeform text: erase the region, let the text enter scrollback, repaint beneath it. A note raised while paused waits for the region to come back rather than printing over the screen that took it. */
  log(text: string): void {
    if (this.paused) {
      this.pendingLogs.push(text);
      return;
    }
    this.eraseRegion();
    this.out.write(`${text}\n`);
    if (!this.stopped) this.paint();
  }

  /** Row/branch/figures layout lives in runTreeFormat.js now; this just paints its Line[] as ANSI. */
  private buildFrame(status: RunStatus): string[] {
    const tree = this.tree!;
    const lines = buildTreeLines(tree, status, this.frame, this.out.rows ?? Number.POSITIVE_INFINITY, this.columns());
    return lines.map((line) => renderLine(line, this.columns()));
  }

  private paint(): void {
    if (!this.tree || this.stopped || this.paused) return;
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
    if (detail) this.out.write(mocha('overlay1', `  ${truncateToWidth(detail, this.columns())}`) + '\n');
    // The per-turn token table lands in scrollback beneath the settled tree,
    // where it has the room the width-capped step rows don't.
    const footer = usageFooter(tree.usageRows(), tree.totalTokens());
    if (footer.length > 0) this.out.write('\n');
    for (const line of footer) this.out.write(mocha('overlay1', truncateToWidth(line, this.columns())) + '\n');
    this.stopped = true;
    this.renderedLines = 0;
    this.out.write(SHOW_CURSOR);
    this.restoreConsole();
    this.out.off?.('resize', this.onResize);
  }
}
