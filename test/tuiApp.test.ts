/**
 * The TUI's app loop and its terminal contract.
 *
 * The assertions that matter here are about restoration, not appearance: the
 * alt screen and cursor must come back on every exit path, a foreground job
 * (a 'run' action) must never leave the alt screen while it runs, and a crash
 * must never leave the user in a cursorless alt buffer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TuiApp } from '../src/ui/tui/app.js';
import { Screen, type TuiStream } from '../src/ui/tui/screen.js';
import { KeyReader, type InStream } from '../src/ui/tui/keys.js';
import { shouldOpenTui } from '../src/ui/tui/index.js';
import { seg } from '../src/ui/tui/line.js';
import { NONE, type Action, type View } from '../src/ui/tui/view.js';
import type { Key } from '../src/ui/tui/keys.js';

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

class FakeStream implements TuiStream {
  written = '';
  columns = 60;
  rows = 12;
  private listeners: Array<() => void> = [];
  write(text: string): void {
    this.written += text;
  }
  on(_event: 'resize', listener: () => void): void {
    this.listeners.push(listener);
  }
  off(_event: 'resize', listener: () => void): void {
    this.listeners = this.listeners.filter((entry) => entry !== listener);
  }
  resize(): void {
    for (const listener of [...this.listeners]) listener();
  }
  get resizeListeners(): number {
    return this.listeners.length;
  }
}

/** A stdin stand-in that records raw-mode transitions and can push keys on demand. */
class FakeInput implements InStream {
  rawModes: boolean[] = [];
  private listener: ((chunk: string) => void) | undefined;
  isTTY = true;
  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  on(_event: 'data', listener: (chunk: string) => void): void {
    this.listener = listener;
  }
  off(): void {
    this.listener = undefined;
  }
  send(chunk: string): void {
    this.listener?.(chunk);
  }
  get attached(): boolean {
    return this.listener !== undefined;
  }
}

/** A scriptable view: returns queued actions in order, then 'none'. */
class ScriptedView implements View {
  keys: Key[] = [];
  constructor(
    private readonly label: string,
    private readonly script: Action[] = [],
  ) {}
  render() {
    return { title: this.label, body: [[seg(this.label)]], hints: 'q quit' };
  }
  onKey(key: Key): Action {
    this.keys.push(key);
    return this.script.shift() ?? NONE;
  }
}

function harness(view: View): { app: TuiApp; out: FakeStream; input: FakeInput } {
  const out = new FakeStream();
  const input = new FakeInput();
  return { app: new TuiApp(view, new Screen(out), new KeyReader(input)), out, input };
}

/** Lets the app finish handling the key just sent. Key handling is async (a view may return a 'run' action that runs a whole workflow), and the app deliberately drops keys arriving while one is in flight. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function send(input: FakeInput, ...chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    input.send(chunk);
    await tick();
  }
}

test('the app enters the alt screen and hides the cursor on start, and restores both on quit', async () => {
  const { app, out, input } = harness(new ScriptedView('home', [{ type: 'quit' }]));
  const running = app.run();
  assert.ok(out.written.startsWith(ENTER_ALT + HIDE_CURSOR));
  input.send('q');
  await running;
  assert.ok(out.written.endsWith(SHOW_CURSOR + EXIT_ALT), 'the terminal must be restored on the way out');
});

test('popping the last view exits, so escape out of the root screen leaves the TUI', async () => {
  const { app, out, input } = harness(new ScriptedView('home', [{ type: 'pop' }]));
  const running = app.run();
  input.send('\x1b');
  await running;
  assert.ok(out.written.endsWith(SHOW_CURSOR + EXIT_ALT));
});

test('a pushed view receives the keys, and popping hands them back to the one underneath', async () => {
  const child = new ScriptedView('child', [{ type: 'pop' }]);
  const root = new ScriptedView('home', [{ type: 'push', view: child }, { type: 'quit' }]);
  const { app, input } = harness(root);
  const running = app.run();
  await send(input, 'a', 'b', 'c'); // push child, pop back to root, quit
  await running;
  assert.deepEqual(
    root.keys.map((key) => key.value),
    ['a', 'c'],
  );
  assert.deepEqual(
    child.keys.map((key) => key.value),
    ['b'],
  );
});

test('the frame is repainted on a terminal resize, and the listener is removed on exit', async () => {
  const { app, out, input } = harness(new ScriptedView('home', [{ type: 'quit' }]));
  const running = app.run();
  const before = out.written.length;
  out.resize();
  assert.ok(out.written.length > before, 'a resize must repaint rather than leave a sheared frame');
  input.send('q');
  await running;
  assert.equal(out.resizeListeners, 0);
});

test('a run action pushes its view and stays on the alt screen for the whole job, then restores dispatch after any key', async () => {
  let altScreenDuringJob = false;
  let redrawn = false;
  const out = new FakeStream();
  const input = new FakeInput();
  const jobView = new ScriptedView('run');
  const view = new ScriptedView('home', [
    {
      type: 'run',
      label: 'run',
      view: jobView,
      run: async (ctx) => {
        // The alt screen must never be exited while the job runs.
        altScreenDuringJob = out.written.lastIndexOf(ENTER_ALT) > out.written.lastIndexOf(EXIT_ALT);
        const beforeRedraw = out.written.length;
        ctx.redraw();
        // Proves redraw() actually repainted, not just that it ran without throwing.
        redrawn = out.written.length > beforeRedraw;
      },
    },
    { type: 'quit' },
  ]);
  const app = new TuiApp(view, new Screen(out), new KeyReader(input));

  const running = app.run();
  input.send('\r'); // triggers the run action
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(altScreenDuringJob, 'the job must run without leaving the alt screen');
  assert.ok(redrawn, 'the ctx.redraw callback must repaint');
  assert.ok(out.written.includes('run'), "the job's own view must be on screen");

  input.send('x'); // dismisses the "press any key" pause
  await new Promise((resolve) => setImmediate(resolve));

  // Dispatch must be restored: the root view (now back on top) receives keys again.
  input.send('q');
  await running;
  assert.ok(out.written.endsWith(SHOW_CURSOR + EXIT_ALT));
});

test('keys pressed while a job runs reach the job view instead of being dropped, without moving the stack', async () => {
  const out = new FakeStream();
  const input = new FakeInput();
  // A job view that asks to pop on every key: the app must ignore it, since
  // only the "press any key" pause may move the stack.
  const jobView = new ScriptedView('run', [{ type: 'pop' }, { type: 'pop' }, { type: 'pop' }]);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const root = new ScriptedView('home', [{ type: 'run', label: 'run', view: jobView, run: () => held }, { type: 'quit' }]);
  const app = new TuiApp(root, new Screen(out), new KeyReader(input));

  const running = app.run();
  await send(input, '\r'); // start the job
  await send(input, 'a', '\x1b[A'); // a char and an up arrow, mid-job

  assert.deepEqual(
    jobView.keys.map((key) => key.value ?? key.name),
    ['a', 'up'],
    'the running job view must receive every key pressed while it runs',
  );
  assert.deepEqual(
    root.keys.map((key) => key.name),
    ['enter'],
    'the app dispatcher must not also see them',
  );

  release?.();
  await tick(); // let runJob settle and swap in its press-any-key listener
  await send(input, 'x'); // dismiss the settled job
  await send(input, 'q'); // dispatch restored: the root view quits
  await running;
  assert.ok(out.written.endsWith(SHOW_CURSOR + EXIT_ALT));
});

test('a key pressed while a job runs repaints, so a scroll or a cancel hint is visible immediately', async () => {
  const out = new FakeStream();
  const input = new FakeInput();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const jobView = new ScriptedView('run');
  const root = new ScriptedView('home', [{ type: 'run', label: 'run', view: jobView, run: () => held }, { type: 'quit' }]);
  const app = new TuiApp(root, new Screen(out), new KeyReader(input));

  const running = app.run();
  await send(input, '\r');
  const before = out.written.length;
  await send(input, 'a');
  assert.ok(out.written.length > before, 'handling a key mid-job must repaint the frame');

  release?.();
  await tick();
  await send(input, 'x', 'q');
  await running;
});

test('an error thrown by a run action is shown as the usual error banner, not a raw write, and clears once dismissed', async () => {
  const out = new FakeStream();
  const input = new FakeInput();
  const jobView = new ScriptedView('run');
  const view = new ScriptedView('home', [
    { type: 'run', label: 'run', view: jobView, run: async () => { throw new Error('forge unreachable'); } },
    { type: 'quit' },
  ]);
  const app = new TuiApp(view, new Screen(out), new KeyReader(input));

  const running = app.run();
  input.send('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(out.written.includes('run failed: forge unreachable'));

  out.written = ''; // isolate the paint that follows dismissal
  input.send('x'); // dismiss — pops the job view and returns to the root
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    !out.written.includes('run failed: forge unreachable'),
    'the error banner must clear after the pause, before the restored root view is drawn — not linger until the next keypress',
  );

  input.send('q');
  await running;
});

test('a view that throws is reported in the frame instead of taking the process down', async () => {
  const out = new FakeStream();
  const input = new FakeInput();
  const view: View = {
    render: () => ({ title: 'home', body: [[seg('home')]], hints: '' }),
    onKey: () => {
      throw new Error('kaboom');
    },
  };
  const app = new TuiApp(view, new Screen(out), new KeyReader(input));
  const running = app.run();
  input.send('x');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(out.written.includes('kaboom'), 'the error is shown in the frame');
  app.stop();
  await running;
  assert.ok(out.written.endsWith(SHOW_CURSOR + EXIT_ALT));
});

test('a view whose render throws still leaves a usable, restorable screen', async () => {
  const out = new FakeStream();
  const input = new FakeInput();
  const view: View = {
    render: () => {
      throw new Error('render exploded');
    },
    onKey: () => NONE,
  };
  const app = new TuiApp(view, new Screen(out), new KeyReader(input));
  const running = app.run();
  assert.ok(out.written.includes('render failed: render exploded'));
  app.stop();
  await running;
  assert.ok(out.written.endsWith(SHOW_CURSOR + EXIT_ALT));
});

test('copyToClipboard hands the text to the terminal as OSC 52, and only while the screen is live', () => {
  const out = new FakeStream();
  const screen = new Screen(out);
  screen.copyToClipboard('https://example/pull/1');
  assert.equal(out.written, '', 'nothing may be written before the alt screen is entered');
  screen.start();
  out.written = '';
  screen.copyToClipboard('https://example/pull/1');
  assert.equal(out.written, `\x1b]52;c;${Buffer.from('https://example/pull/1', 'utf8').toString('base64')}\x07`);
  screen.stop();
});

test('a stopped screen ignores further paints, so nothing can draw after the terminal is restored', () => {
  const out = new FakeStream();
  const screen = new Screen(out);
  screen.start();
  screen.stop();
  const after = out.written.length;
  screen.paint([[seg('late')]]);
  assert.equal(out.written.length, after);
});

test('painting never emits more rows than the terminal has, and never a trailing newline that would scroll the alt buffer', () => {
  const out = new FakeStream();
  const screen = new Screen(out);
  screen.start();
  out.written = '';
  screen.paint(Array.from({ length: 50 }, (_, i) => [seg(`row ${i}`)]));
  const rows = out.written.split('\r\n');
  assert.equal(rows.length, out.rows);
  assert.ok(!out.written.endsWith('\n'));
  screen.stop();
});

test('shouldOpenTui only takes over a bare invocation on a fully interactive terminal', () => {
  assert.equal(shouldOpenTui([], true, true), true);
  assert.equal(shouldOpenTui(['run'], true, true), false, 'an explicit subcommand always wins');
  assert.equal(shouldOpenTui(['--ticket', 'X'], true, true), false, 'flags mean the user asked for a run');
  assert.equal(shouldOpenTui([], false, true), false, 'piped stdin cannot drive a TUI');
  assert.equal(shouldOpenTui([], true, false), false, 'redirected stdout must stay greppable');
});
