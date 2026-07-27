/**
 * Raw-mode keyboard input for the TUI: a pure byte-sequence parser plus a thin
 * reader that puts stdin into raw mode and feeds parsed keys to a listener.
 *
 * Hand-rolled rather than pulled from a dependency — CLAUDE.md caps runtime
 * deps at commander + zod + toon, and terminal key decoding is well under
 * the ~150-line bar that rule draws. Only the sequences the TUI actually binds
 * are decoded; anything unrecognized is dropped rather than thrown, because the
 * UI layer must never kill the process (CLAUDE.md's never-throw contract).
 */

export type KeyName =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'escape'
  | 'backspace'
  | 'delete'
  | 'tab'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'char'
  | 'ctrl';

export interface Key {
  name: KeyName;
  /** The character for 'char', or the lowercase letter for 'ctrl' (ctrl-c -> 'c'). */
  value?: string;
}

/** Final byte of a CSI/SS3 sequence -> key, for the cursor/navigation block. */
const CSI_LETTER: Record<string, KeyName> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

/** Numeric CSI parameter of a `ESC [ n ~` sequence -> key. */
const CSI_TILDE: Record<string, KeyName> = {
  '1': 'home',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

/** True for the final byte of a CSI sequence (ECMA-48: the range `@` to `~`). */
function isFinalByte(ch: string): boolean {
  return ch >= '@' && ch <= '~';
}

/**
 * Decodes one `ESC [ … final` / `ESC O final` sequence starting at `start`
 * (which points at the `[` or `O`), returning the key it means — or undefined
 * for a sequence the TUI does not bind — and where scanning should resume.
 */
function readEscapeSequence(input: string, start: number): { key: Key | undefined; next: number } {
  let i = start + 1;
  let params = '';
  while (i < input.length && !isFinalByte(input[i])) {
    params += input[i];
    i += 1;
  }
  // A truncated sequence (the chunk boundary split it) consumes what it has.
  if (i >= input.length) return { key: undefined, next: input.length };
  const final = input[i];
  const name = final === '~' ? CSI_TILDE[params] : CSI_LETTER[final];
  return { key: name ? { name } : undefined, next: i + 1 };
}

/**
 * Turns one raw stdin chunk into the keys it represents. Pure, so every
 * binding the TUI relies on is unit-testable without a terminal.
 */
// fallow-ignore-next-line complexity
export function parseKeys(input: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\x1b') {
      const nextCh = input[i + 1];
      if (nextCh === '[' || nextCh === 'O') {
        const { key, next } = readEscapeSequence(input, i + 1);
        if (key) keys.push(key);
        i = next;
        continue;
      }
      // A lone ESC is the escape key; ESC followed by anything else is an
      // alt-modified key the TUI does not bind, so the ESC is dropped with it.
      keys.push({ name: 'escape' });
      i += nextCh === undefined ? 1 : 2;
      continue;
    }
    if (ch === '\r' || ch === '\n') keys.push({ name: 'enter' });
    else if (ch === '\t') keys.push({ name: 'tab' });
    else if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' });
    else {
      const code = ch.charCodeAt(0);
      if (code < 0x20) keys.push({ name: 'ctrl', value: String.fromCharCode(code + 96) });
      else keys.push({ name: 'char', value: ch });
    }
    i += 1;
  }
  return keys;
}

/** The slice of stdin the reader needs — injectable so tests drive a fake. */
export interface InStream {
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  off?(event: 'data', listener: (chunk: string) => void): unknown;
  isTTY?: boolean;
}

/**
 * Puts stdin in raw mode (no line buffering, no terminal echo, no automatic
 * ctrl-C) and delivers decoded keys to `listener`. Only one listener is ever
 * attached at a time, via the internal 'data' handler's single-listener
 * field — swapping listeners (app.ts's waitForAnyKey does this around a
 * finished job's dismissal) must call stop() before the next start(), or the
 * 'data' handler ends up registered twice and double-fires every keystroke.
 */
export class KeyReader {
  private listener: ((key: Key) => void) | undefined;
  private readonly onData = (chunk: string): void => {
    const handle = this.listener;
    if (!handle) return;
    for (const key of parseKeys(String(chunk))) handle(key);
  };

  constructor(private readonly input: InStream = process.stdin) {}

  start(listener: (key: Key) => void): void {
    this.listener = listener;
    this.input.setRawMode?.(true);
    this.input.setEncoding?.('utf8');
    this.input.resume?.();
    this.input.on('data', this.onData);
  }

  stop(): void {
    this.listener = undefined;
    this.input.off?.('data', this.onData);
    this.input.setRawMode?.(false);
    this.input.pause?.();
  }
}
