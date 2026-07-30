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
import { navIntent } from '../list.js';
import { NONE, hints, type Action, type RenderedView, type View } from '../view.js';
import { buildTreeLines } from '../../runTreeFormat.js';
import { usageFooter } from '../../format.js';
import { setRenderer } from '../../steps.js';
import { beginCancelScope, requestCancel } from '../../../process/cancelScope.js';
import type { MochaRole } from '../../theme.js';
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

/**
 * How long a first ctrl-c stays armed. A single stray press must not throw
 * away a ten-minute run, and a deliberate stop is two presses in a row —
 * which is how long it takes to read the footer asking for the second one.
 */
const CANCEL_ARM_MS = 2000;

/**
 * The MR/PR link the run narrated (openMergeRequest.ts notes it, watchPipeline
 * repeats it on escalation). Pulled out of the notes rather than threaded
 * through the renderer contract, so the result section can end on the one
 * thing the user goes looking for next.
 */
const MR_URL = /https?:\/\/\S+?(?:\/-\/merge_requests\/|\/pull\/)\d+/;

/**
 * The closing line, in the same glyph vocabulary the step tree uses (✓ ✗ ○ –,
 * see runTreeFormat.ts's statusGlyph) rather than emoji. Two reasons: the run
 * is being read alongside that tree, so a second symbol set is noise; and
 * emoji are double-width in most terminals while fitLine measures in code
 * units, which is exactly how a frame's right border ends up one column out.
 */
const FINAL_LINE: Record<Exclude<RunStatus, 'running'>, { glyph: string; label: string; role: MochaRole }> = {
  done: { glyph: '✓', label: 'Done', role: 'green' },
  failed: { glyph: '✗', label: 'Run failed', role: 'red' },
  escalated: { glyph: '!', label: 'Stopped for human review', role: 'yellow' },
  interrupted: { glyph: '■', label: 'Interrupted', role: 'overlay1' },
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
  /** undefined = follow the newest note; a number pins the window while the user reads back. */
  private noteOffset: number | undefined;
  /** How many note rows the last render had room for — the page size onKey scrolls by. */
  private noteBudget = 1;
  private cancelArmedAt: number | undefined;
  private cancelRequested = false;
  private mrUrl: string | undefined;

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

  /** Latest wins: a follow-up run narrates the MR/PR it appended to after the one it looked up. */
  private captureMrUrl(text: string | undefined): void {
    const found = text ? MR_URL.exec(text) : null;
    if (found) this.mrUrl = found[0];
  }

  log(text: string): void {
    this.captureMrUrl(text);
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
    this.captureMrUrl(detail);
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
      // than pushing the (more important) live step tree off screen — unless
      // the user has scrolled back, in which case their window is honored.
      const budget = Math.max(1, Math.floor(inner.rows / 4));
      this.noteBudget = budget;
      const start = this.noteWindowStart(budget);
      const scrolled = this.noteOffset !== undefined;
      const label = scrolled ? `notes ${start + 1}-${Math.min(start + budget, this.notes.length)} of ${this.notes.length}` : 'notes';
      body.push(sectionRow(label, inner.columns));
      for (const text of this.notes.slice(start, start + budget)) body.push([seg(text, { role: 'subtext0' })]);
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
      const final = FINAL_LINE[this.finalStatus ?? 'done'];
      body.push([]);
      body.push(sectionRow('result', inner.columns));
      body.push([seg(`${final.glyph} `, { role: final.role, bold: true }), seg(final.label, { bold: true })]);
      if (this.detail) for (const text of wrap(this.detail, inner.columns)) body.push([seg(text, { role: 'subtext0' })]);
      if (this.mrUrl) body.push([seg('mr/pr  ', { role: 'overlay1' }), seg(this.mrUrl, { role: 'mauve' })]);
    }

    return { title: this.tree?.header.title ?? 'run', body, hints: this.hints() };
  }

  private maxNoteOffset(budget: number): number {
    return Math.max(0, this.notes.length - budget);
  }

  /** Where the notes window starts: pinned when scrolled, else the tail. Re-clamped every render, since new notes move the tail. */
  private noteWindowStart(budget: number): number {
    const max = this.maxNoteOffset(budget);
    return this.noteOffset === undefined ? max : Math.min(this.noteOffset, max);
  }

  /** Scrolls the notes window; reaching the bottom clears the pin so the view follows new notes again, like every log pager. */
  private scrollNotes(delta: number): void {
    const max = this.maxNoteOffset(this.noteBudget);
    const next = Math.max(0, Math.min(max, (this.noteOffset ?? max) + delta));
    this.noteOffset = next >= max ? undefined : next;
  }

  private cancelArmed(): boolean {
    return this.cancelArmedAt !== undefined && Date.now() - this.cancelArmedAt <= CANCEL_ARM_MS;
  }

  /** First ctrl-c arms, a second one within the window asks the run to stop at its next boundary (see process/cancelScope.ts). */
  private armOrRequestCancel(): void {
    if (this.cancelArmed()) {
      this.cancelArmedAt = undefined;
      this.cancelRequested = true;
      requestCancel();
      return;
    }
    this.cancelArmedAt = Date.now();
  }

  private hints(): string {
    if (this.finished) return 'press any key to continue';
    if (this.cancelRequested) return 'stopping after the current step…';
    if (this.cancelArmed()) return 'ctrl-c again to stop this run';
    return hints('j/k scroll notes', 'G follow', 'ctrl-c stop');
  }

  onKey(key: Key): Action {
    // Once settled, any key dismisses — TuiApp's waitForAnyKey owns that
    // handoff, so this is only reached when the app is still dispatching.
    if (this.finished) return { type: 'pop' };
    if (key.name === 'ctrl' && key.value === 'c') {
      this.armOrRequestCancel();
      return NONE;
    }
    // Page keys move by whatever the last render had room for, so ctrl-d
    // advances exactly one screen of notes rather than a guessed constant.
    const nav = navIntent(key, this.noteBudget);
    if (nav?.kind === 'move') this.scrollNotes(nav.delta);
    else if (nav?.kind === 'first') this.noteOffset = 0;
    // 'G' means "bottom", which on a live log is the tail — clearing the pin
    // resumes following new notes rather than freezing on the current last row.
    else if (nav?.kind === 'last') this.noteOffset = undefined;
    // Never a navigation action: a running job may not move the view stack.
    return NONE;
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
      // Armed and disposed in lockstep with the renderer: a cancel requested
      // after the job settles lands on a dead scope and does nothing.
      const disposeCancelScope = beginCancelScope();
      setRenderer(dashboard);
      return task().finally(() => {
        setRenderer(undefined);
        disposeCancelScope();
      });
    },
  };
}
