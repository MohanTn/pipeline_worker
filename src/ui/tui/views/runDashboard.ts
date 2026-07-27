/**
 * The run's live progress inside the TUI's alt screen: implements both View
 * (so TuiApp can paint it in the view stack) and Renderer (so ui/steps.ts can
 * drive it exactly the way it drives TreeRenderer for the plain CLI). Reuses
 * ui/runTreeFormat.js for the tree layout so the two dashboards draw
 * identically — only the paint mechanism differs (ANSI region redraw there,
 * TuiApp's Screen.paint() here), and the body is organized into the same
 * labeled sections (chrome.js's sectionRow) every other TUI screen uses,
 * instead of one undifferentiated block of dim text.
 *
 * `runInDashboard` is the one place every screen that starts a job (the run
 * launcher, the sessions browser's resume/review) builds this wiring, so
 * ui/steps.ts's setRenderer() is always paired with a matching clear.
 */

import { seg, wrap, type Line } from '../line.js';
import { sectionRow } from '../chrome.js';
import { NONE, type Action, type RenderedView, type View } from '../view.js';
import { buildTreeLines } from '../../runTreeFormat.js';
import { usageFooter } from '../../format.js';
import { setRenderer } from '../../steps.js';
import type { Renderer } from '../../renderer.js';
import type { RunStatus, RunTree, TreeEvent } from '../../runTree.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';

/** Enough recent freeform log() lines (notes, agent output) to give context above the tree without unbounded memory on a very long run. */
const MAX_NOTE_LINES = 200;

/**
 * How often the view repaints on its own, independent of tree events — the
 * running step's spinner glyph and elapsed-time counter are only redrawn when
 * something calls render(), so without a tick a multi-second gap between
 * events (a CI poll, an agent turn) would freeze the animation on one frame.
 * Mirrors TreeRenderer's own PAINT_INTERVAL_MS for the plain CLI.
 */
const TICK_MS = 80;

const FINAL_LINE: Record<Exclude<RunStatus, 'running'>, string> = {
  done: '🎉 Done',
  failed: '✗ Run failed',
  escalated: '🚨 Stopped for human review',
  interrupted: '⏹ Interrupted',
};

export class RunDashboardView implements View, Renderer {
  private tree: RunTree | undefined;
  private status: RunStatus = 'running';
  private finalStatus: Exclude<RunStatus, 'running'> | undefined;
  private detail: string | undefined;
  private frame = 0;
  private finished = false;
  private readonly notes: string[] = [];
  private usageLines: string[] = [];
  private redraw: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Wired by runInDashboard() once TuiApp hands over the 'run' action's redraw callback; starts the animation tick. */
  bindRedraw(redraw: () => void): void {
    this.redraw = redraw;
    this.timer = setInterval(() => this.redraw?.(), TICK_MS);
    this.timer.unref?.();
  }

  onEvent(_event: TreeEvent, tree: RunTree): void {
    this.tree = tree;
    this.status = tree.header.status;
    this.redraw?.();
  }

  log(text: string): void {
    this.notes.push(text);
    if (this.notes.length > MAX_NOTE_LINES) this.notes.shift();
    this.redraw?.();
  }

  stop(status: RunStatus, detail: string | undefined, tree: RunTree): void {
    if (status === 'running') return;
    if (this.timer) clearInterval(this.timer);
    this.tree = tree;
    this.status = status;
    this.finalStatus = status;
    this.detail = detail;
    this.finished = true;
    // usageFooter's own hand-formatted '── token usage ──' header is sized
    // for the plain CLI's unboxed scrollback; drop it in favor of this
    // view's own sectionRow, which matches every other TUI screen and fits
    // the frame's actual width.
    this.usageLines = usageFooter(tree.usageRows(), tree.totalTokens()).slice(1);
    this.redraw?.();
  }

  render(inner: Size): RenderedView {
    this.frame += 1;
    const body: Line[] = [];

    if (this.notes.length > 0) {
      // Most recent notes first fill the section; older ones drop off rather
      // than pushing the (more important) live step tree off screen.
      const budget = Math.max(1, Math.floor(inner.rows / 4));
      body.push(sectionRow('notes', inner.columns));
      for (const text of this.notes.slice(-budget)) body.push([seg(text, { role: 'overlay1' })]);
      body.push([]);
    }

    if (this.usageLines.length > 0) {
      body.push(sectionRow('token usage', inner.columns));
      for (const text of this.usageLines) body.push([seg(text, { role: 'overlay1' })]);
      body.push([]);
    }

    body.push(sectionRow('steps', inner.columns));
    const treeBudget = Math.max(1, inner.rows - body.length - (this.finished ? 3 : 0));
    body.push(...(this.tree ? buildTreeLines(this.tree, this.status, this.frame, treeBudget, inner.columns) : [[seg('starting…', { role: 'overlay1' })]]));

    if (this.finished) {
      body.push([]);
      body.push(sectionRow('result', inner.columns));
      body.push([seg(this.finalStatus ? FINAL_LINE[this.finalStatus] : 'Done', { bold: true })]);
      if (this.detail) for (const text of wrap(this.detail, inner.columns)) body.push([seg(text, { role: 'overlay1' })]);
    }

    return {
      title: this.tree?.header.title ?? 'run',
      body,
      hints: this.finished ? 'press any key to continue' : 'running…',
    };
  }

  onKey(_key: Key): Action {
    return this.finished ? { type: 'pop' } : NONE;
  }
}

/**
 * Builds the { type: 'run' } Action every job-starting screen needs: a fresh
 * dashboard, wired to ui/steps.ts for the duration of `task`, cleared again
 * once it settles (success or failure) so a later non-TUI renderer selection
 * is never left pointed at a finished view.
 */
export function runInDashboard(label: string, task: () => Promise<void>): Action {
  const dashboard = new RunDashboardView();
  return {
    type: 'run',
    label,
    view: dashboard,
    run: (ctx) => {
      dashboard.bindRedraw(ctx.redraw);
      setRenderer(dashboard);
      return task().finally(() => setRenderer(undefined));
    },
  };
}
