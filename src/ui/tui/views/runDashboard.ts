/**
 * The run's live progress inside the TUI's alt screen: implements both View
 * (so TuiApp can paint it in the view stack) and Renderer (so ui/steps.ts can
 * drive it exactly the way it drives TreeRenderer for the plain CLI). Reuses
 * ui/runTreeFormat.js for the tree layout so the two dashboards draw
 * identically — only the paint mechanism differs (ANSI region redraw there,
 * TuiApp's Screen.paint() here).
 *
 * `runInDashboard` is the one place every screen that starts a job (the run
 * launcher, the sessions browser's resume/review) builds this wiring, so
 * ui/steps.ts's setRenderer() is always paired with a matching clear.
 */

import { seg, wrap, type Line } from '../line.js';
import { NONE, type Action, type RenderedView, type View } from '../view.js';
import { buildTreeLines } from '../../runTreeFormat.js';
import { usageFooter } from '../../format.js';
import { setRenderer } from '../../steps.js';
import type { Renderer } from '../../renderer.js';
import type { RunStatus, RunTree, TreeEvent } from '../../runTree.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';

/** Enough recent freeform log() lines (notes, agent output) to give context above the tree without unbounded memory on a very long run. */
const MAX_LOG_LINES = 200;

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
  private readonly logs: string[] = [];
  private redraw: (() => void) | undefined;

  /** Wired by runInDashboard() once TuiApp hands over the 'run' action's redraw callback. */
  bindRedraw(redraw: () => void): void {
    this.redraw = redraw;
  }

  onEvent(_event: TreeEvent, tree: RunTree): void {
    this.tree = tree;
    this.status = tree.header.status;
    this.redraw?.();
  }

  log(text: string): void {
    this.logs.push(text);
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
    this.redraw?.();
  }

  stop(status: RunStatus, detail: string | undefined, tree: RunTree): void {
    if (status === 'running') return;
    this.tree = tree;
    this.status = status;
    this.finalStatus = status;
    this.detail = detail;
    this.finished = true;
    this.logs.push(...usageFooter(tree.usageRows(), tree.totalTokens()));
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.redraw?.();
  }

  render(inner: Size): RenderedView {
    this.frame += 1;
    const tail: Line[] = [];
    if (this.finished) {
      tail.push([]);
      tail.push([seg(this.finalStatus ? FINAL_LINE[this.finalStatus] : 'Done', { bold: true })]);
      if (this.detail) for (const text of wrap(this.detail, inner.columns)) tail.push([seg(text, { role: 'overlay1' })]);
    }
    const logBudget = Math.max(0, Math.min(this.logs.length, Math.floor(inner.rows / 3)));
    const logLines: Line[] = this.logs.slice(this.logs.length - logBudget).map((text) => [seg(text, { role: 'overlay1' })]);
    const treeBudget = Math.max(1, inner.rows - logLines.length - tail.length);
    const treeLines = this.tree ? buildTreeLines(this.tree, this.status, this.frame, treeBudget, inner.columns) : [[seg('starting…', { role: 'overlay1' })]];
    return {
      title: this.tree?.header.title ?? 'run',
      body: [...logLines, ...treeLines, ...tail],
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
