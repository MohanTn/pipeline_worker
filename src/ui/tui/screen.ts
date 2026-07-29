/**
 * The TUI's drawing surface: the terminal's alternate screen buffer.
 *
 * Unlike the plain-CLI run dashboard (ui/treeRenderer.ts), which pins a
 * region at the bottom of the normal buffer so log lines can scroll past it,
 * the TUI owns the whole screen — so it switches to the alt buffer, paints
 * absolute frames, and switches back on exit, leaving the user's scrollback
 * exactly as it was. A run started from inside the TUI stays on the alt
 * screen for its whole duration (see app.ts's runJob) — the screen is never
 * left mid-session the way it used to be.
 *
 * Terminal restoration is the invariant that matters: alt buffer and cursor
 * are restored by stop(), and by a process 'exit' hook (a sync write, which
 * is allowed there) — so a crash or a ctrl-C can never strand the user in a
 * cursorless alt screen.
 */

import { renderLine, type Line } from './line.js';

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const ERASE_TO_END_OF_LINE = '\x1b[K';
const ERASE_BELOW = '\x1b[J';

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/** The slice of a TTY WriteStream the TUI needs — injectable so tests drive a fake with fixed geometry. */
export interface TuiStream {
  write(text: string): void;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): void;
  off?(event: 'resize', listener: () => void): void;
}

export interface Size {
  columns: number;
  rows: number;
}

export class Screen {
  private active = false;
  private onResize: (() => void) | undefined;
  private readonly restoreOnExit = (): void => {
    if (this.active) this.out.write(SHOW_CURSOR + EXIT_ALT);
  };

  constructor(private readonly out: TuiStream = process.stdout) {}

  /**
   * A terminal does not always report a usable size: a pty with no size set
   * (a `script` session, some CI runners) reports 0 rather than undefined, and
   * a resize can be observed mid-flight. `?? DEFAULT` alone would keep the 0
   * and paint an empty screen, so anything not a positive integer falls back.
   */
  size(): Size {
    const usable = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    return { columns: usable(this.out.columns, DEFAULT_COLUMNS), rows: usable(this.out.rows, DEFAULT_ROWS) };
  }

  start(onResize?: () => void): void {
    if (this.active) return;
    this.active = true;
    this.onResize = onResize;
    this.out.write(ENTER_ALT + HIDE_CURSOR);
    process.once('exit', this.restoreOnExit);
    if (onResize) this.out.on?.('resize', onResize);
  }

  /**
   * Paints one absolute frame: home the cursor, write each row clearing its
   * tail, then erase everything below. No trailing newline after the final
   * row — on the bottom row that would scroll the alt buffer by one line and
   * shear every subsequent frame.
   */
  paint(lines: Line[]): void {
    if (!this.active) return;
    const { columns, rows } = this.size();
    const visible = lines.slice(0, rows);
    const painted = visible.map((line) => renderLine(line, columns) + ERASE_TO_END_OF_LINE);
    this.out.write(CURSOR_HOME + painted.join('\r\n') + ERASE_BELOW);
  }

  /**
   * Hands `text` to the terminal's own clipboard with OSC 52, which works over
   * ssh (the terminal emulator does the copying, not the host) and needs no
   * clipboard dependency. A terminal with OSC 52 disabled silently ignores it,
   * so callers always show the text as well.
   */
  copyToClipboard(text: string): void {
    if (!this.active) return;
    this.out.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.onResize) this.out.off?.('resize', this.onResize);
    this.onResize = undefined;
    this.out.write(SHOW_CURSOR + EXIT_ALT);
  }
}
