/**
 * The TUI's event loop: a stack of views, a key reader, and a screen.
 *
 * Three rules keep it honest:
 *
 * - Keys are handled one at a time. A view's onKey may be async (a suspend
 *   runs a whole workflow), so incoming keys are dropped while one is in
 *   flight rather than queued — a held-down arrow key must not stack up a
 *   hundred pending navigations behind a running job.
 * - A view that throws is caught and shown as an error banner rather than
 *   taking the process down, per CLAUDE.md's never-throw UI contract.
 * - The screen is restored on every exit path: quit, empty stack, ctrl-C, an
 *   unhandled throw, and around every suspend.
 */

import { frame, innerSize } from './chrome.js';
import { seg, type Line } from './line.js';
import { KeyReader, type Key } from './keys.js';
import { Screen } from './screen.js';
import type { Action, View } from './view.js';

/** Printed on the normal screen while a suspended job runs, so the handover is visible rather than looking like a crash. */
function suspendBanner(label: string): string {
  return `\n── pipeline-worker · ${label} ────────────────────────────\n`;
}

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

  /** Leaves the alt screen, runs the job against the normal terminal with cooked stdin, then restores the TUI. */
  private async suspend(label: string, run: () => Promise<void>): Promise<void> {
    this.keys.stop();
    await this.screen.suspend(async () => {
      process.stdout.write(suspendBanner(label));
      try {
        await run();
      } catch (error) {
        this.error = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
        process.stdout.write(`\n${this.error}\n`);
      }
      process.stdout.write('\nPress any key to return to pipeline-worker…');
      await this.waitForAnyKey();
    });
    this.keys.start((key) => void this.onKey(key));
  }

  /**
   * The "press any key" pause after a suspended job, so its output stays on
   * screen long enough to read before the alt screen swallows it. Reuses the
   * app's own reader rather than opening a second one on process.stdin —
   * two readers in raw mode on one stdin race for every byte.
   */
  private waitForAnyKey(): Promise<void> {
    return new Promise((resolve) => {
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
      case 'suspend':
        await this.suspend(action.label, action.run);
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
