/**
 * The TUI's event loop: a stack of views, a key reader, and a screen.
 *
 * Three rules keep it honest:
 *
 * - Keys are handled one at a time. A view's onKey may be async (a 'run'
 *   action runs a whole workflow), so incoming keys are dropped while one is
 *   in flight rather than queued — a held-down arrow key must not stack up a
 *   hundred pending navigations behind a running job.
 * - A view that throws is caught and shown as an error banner rather than
 *   taking the process down, per CLAUDE.md's never-throw UI contract.
 * - The screen is restored on every exit path: quit, empty stack, ctrl-C, and
 *   an unhandled throw. Unlike the old suspend()-based design, a 'run' action
 *   never leaves the alt screen at all — see screen.ts.
 */

import { frame, innerSize } from './chrome.js';
import { seg, type Line } from './line.js';
import { KeyReader, type Key } from './keys.js';
import { Screen } from './screen.js';
import type { Action, View } from './view.js';

export class TuiApp {
  private readonly stack: View[] = [];
  private busy = false;
  private done = false;
  private error: string | undefined;
  private resolveExit: (() => void) | undefined;

  constructor(
    root: View,
    private readonly screen: Screen = new Screen(),
    private readonly keys: KeyReader = new KeyReader(),
  ) {
    this.stack.push(root);
  }

  private current(): View | undefined {
    return this.stack[this.stack.length - 1];
  }

  private draw(): void {
    const view = this.current();
    if (!view) return;
    const size = this.screen.size();
    try {
      const rendered = view.render(innerSize(size));
      const body: Line[] = this.error ? [[seg(this.error, { role: 'red' })], [], ...rendered.body] : rendered.body;
      this.screen.paint(frame({ title: `pipeline-worker · ${rendered.title}`, body, hints: rendered.hints }, size));
    } catch (error) {
      // A view that cannot even render is not worth taking the process down
      // for; show why and keep the stack navigable.
      const message = error instanceof Error ? error.message : String(error);
      this.screen.paint(frame({ title: 'pipeline-worker', body: [[seg(`render failed: ${message}`, { role: 'red' })]], hints: 'q back' }, size));
    }
  }

  /**
   * Runs a foreground job (a workflow run, a resume, a review) without
   * leaving the alt screen: pushes the job's own view, redraws on demand as
   * the job reports progress through `ctx.redraw`, then leaves the finished
   * view up until any key is pressed. Errors surface as the usual error
   * banner rather than a raw write, and are shown on the still-pushed view.
   */
  private async runJob(label: string, view: View, run: (ctx: { redraw(): void }) => Promise<void>): Promise<void> {
    this.stack.push(view);
    this.draw();
    // Keys go straight to the job's own view for the duration. The app-level
    // dispatcher would drop them (onKey's `busy` guard, held for this whole
    // await), which is right for navigation — a job must not have a hundred
    // pending pushes stacked behind it — but wrong for the job's own screen,
    // which needs them to scroll and to be cancelled. Actions the view
    // returns are deliberately discarded: only waitForAnyKey below may move
    // the stack. Stop first, per KeyReader's single-listener contract.
    this.keys.stop();
    this.keys.start((key) => {
      void Promise.resolve(view.onKey(key)).then(() => this.draw());
    });
    try {
      await run({ redraw: () => this.draw() });
    } catch (error) {
      this.error = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.draw();
    await this.waitForAnyKey();
    // The dismissal keypress never goes through onKey (waitForAnyKey uses
    // its own one-shot listener), so it wouldn't otherwise clear this — an
    // error from the finished job must not linger as a banner over the
    // screen it returns to.
    this.error = undefined;
    // Swap the one-shot listener back for normal dispatch — see
    // waitForAnyKey's note on why the reader is stopped first.
    this.keys.start((key) => void this.onKey(key));
    this.stack.pop();
  }

  /**
   * The "press any key" pause after a job settles, so its final frame stays
   * on screen long enough to read before the view stack moves on. Reuses the
   * app's own reader rather than opening a second one on process.stdin — two
   * readers in raw mode on one stdin race for every byte. KeyReader.start()
   * re-registers its 'data' listener rather than replacing it, so the normal
   * dispatching listener is stopped first; otherwise both would fire on every
   * keystroke.
   */
  private waitForAnyKey(): Promise<void> {
    return new Promise((resolve) => {
      this.keys.stop();
      this.keys.start(() => {
        this.keys.stop();
        resolve();
      });
    });
  }

  private async apply(action: Action): Promise<void> {
    switch (action.type) {
      case 'push':
        this.stack.push(action.view);
        break;
      case 'pop':
        this.stack.pop();
        if (this.stack.length === 0) this.exit();
        break;
      case 'quit':
        this.exit();
        break;
      case 'run':
        await this.runJob(action.label, action.view, action.run);
        break;
      default:
        break;
    }
  }

  private async onKey(key: Key): Promise<void> {
    if (this.busy || this.done) return;
    const view = this.current();
    if (!view) return;
    this.busy = true;
    // Any keypress clears the last error banner: it has been read by now, and
    // leaving it pinned would make the next screen look broken.
    this.error = undefined;
    try {
      await this.apply(await view.onKey(key));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      if (!this.done) this.draw();
    }
  }

  /** Ends the loop and restores the terminal. Idempotent, so a signal handler and a quit action can both call it. */
  stop(): void {
    if (this.done) return;
    this.done = true;
    this.keys.stop();
    this.screen.stop();
    this.resolveExit?.();
  }

  private exit(): void {
    this.stop();
  }

  /** Runs until a view quits or the stack empties. Resolves with the terminal fully restored. */
  async run(): Promise<void> {
    this.screen.start(() => this.draw());
    this.keys.start((key) => void this.onKey(key));
    this.draw();
    try {
      await new Promise<void>((resolve) => {
        this.resolveExit = resolve;
      });
    } finally {
      this.exit();
    }
  }
}
