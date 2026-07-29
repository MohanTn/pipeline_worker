/**
 * The TUI's live run screen: a RunTree drawn into the alt screen instead of
 * onto raw stdout. It implements both View (TuiApp paints it) and Renderer
 * (ui/steps.ts drives it), so these tests feed it TreeEvents the way
 * ensureActive()/runStep() would, and assert on the Line[] it renders.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RunDashboardView, runInDashboard } from '../src/ui/tui/views/runDashboard.js';
import { plainText, type Line } from '../src/ui/tui/line.js';
import { RunTree } from '../src/ui/runTree.js';
import { beginCancelScope, isCancelRequested } from '../src/process/cancelScope.js';

const SIZE = { columns: 90, rows: 24 };
/** rows/4 — the note budget render() computes for SIZE. */
const NOTE_ROWS = 6;
const CTRL_C = { name: 'ctrl', value: 'c' } as const;

function textOf(view: RunDashboardView): string[] {
  return view.render(SIZE).body.map((line: Line) => plainText(line));
}

test('before any event arrives, the dashboard shows a pending frame instead of throwing', () => {
  const dashboard = new RunDashboardView();
  assert.doesNotThrow(() => dashboard.render(SIZE));
  assert.ok(textOf(dashboard).some((line) => line.includes('starting')));
});

test('onEvent draws the tree exactly as the plain CLI would, and calls the bound redraw', () => {
  const dashboard = new RunDashboardView();
  let redraws = 0;
  dashboard.bindRedraw(() => {
    redraws += 1;
  });
  const tree = new RunTree(
    [{ id: 'capture', label: 'capture', detail: 'staged + unstaged diff' }],
    { title: 'add-login' },
    (event) => dashboard.onEvent(event, tree),
  );
  dashboard.onEvent({ kind: 'header' }, tree);
  assert.ok(redraws > 0, 'binding a redraw callback must be invoked on tree events');
  const shown = textOf(dashboard).join('\n');
  assert.match(shown, /add-login/);
  assert.match(shown, /○ capture/);

  tree.start('capture', { detail: 'reading the diff' });
  assert.match(textOf(dashboard).join('\n'), /capture\s+reading the diff/);
});

test('log() lines from steps.ts (note/announce) appear under their own "notes" section, separate from the steps', () => {
  const dashboard = new RunDashboardView();
  dashboard.log('  agent: fixed the failing test');
  const shown = textOf(dashboard);
  const notesHeader = shown.findIndex((line) => line.includes('notes'));
  const noteLine = shown.findIndex((line) => line.includes('agent: fixed the failing test'));
  const stepsHeader = shown.findIndex((line) => line.includes('steps'));
  assert.ok(notesHeader >= 0 && noteLine > notesHeader, 'the note must be under the notes header');
  assert.ok(stepsHeader > noteLine, 'the steps section must come after the notes, not interleaved with them');
});

test('the result section ends on the mr/pr link the run narrated', () => {
  const dashboard = new RunDashboardView();
  const tree = new RunTree([{ id: 'mr', label: 'mr' }], { title: 'add-login' }, () => {});
  dashboard.log('https://gitlab.example/group/app/-/merge_requests/12');
  dashboard.stop('escalated', 'see the MR for what was tried and why', tree);
  const shown = textOf(dashboard).join('\n');
  assert.match(shown, /mr\/pr\s+https:\/\/gitlab\.example\/group\/app\/-\/merge_requests\/12/);
});

test('a run that never opened an mr/pr shows no link row', () => {
  const dashboard = new RunDashboardView();
  const tree = new RunTree([{ id: 'checks', label: 'checks' }], { title: 'add-login' }, () => {});
  dashboard.log('local checks failed');
  dashboard.stop('failed', 'lint failed', tree);
  assert.ok(!textOf(dashboard).some((line) => line.startsWith('mr/pr')));
});

test('bindRedraw starts an animation tick, so the spinner keeps moving between tree events; stop() cancels it', async () => {
  const dashboard = new RunDashboardView();
  let redraws = 0;
  dashboard.bindRedraw(() => {
    redraws += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(redraws >= 2, `expected several timer-driven redraws with no tree events at all, got ${redraws}`);

  const tree = new RunTree([], { title: 'add-login' }, (event) => dashboard.onEvent(event, tree));
  dashboard.stop('done', undefined, tree); // triggers one last redraw itself, then clears the timer
  const afterStop = redraws;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(redraws, afterStop, 'the timer must not fire again once the run has settled');
});

test('stop() shows the terminal status, the detail line, and switches the hint to press-any-key', () => {
  const dashboard = new RunDashboardView();
  const tree = new RunTree([{ id: 'capture', label: 'capture', detail: '' }], { title: 'add-login' }, (event) => dashboard.onEvent(event, tree));
  dashboard.onEvent({ kind: 'header' }, tree);
  tree.finish('capture', 'done');

  dashboard.stop('done', 'MR #12 merged', tree);
  const rendered = dashboard.render(SIZE);
  const shown = rendered.body.map(plainText).join('\n');
  assert.match(shown, /Done/);
  assert.match(shown, /MR #12 merged/);
  assert.equal(rendered.hints, 'press any key to continue');
});

test('stop() with status "running" is a no-op — only a terminal status settles the dashboard', () => {
  const dashboard = new RunDashboardView();
  const tree = new RunTree([{ id: 'capture', label: 'capture', detail: '' }], { title: 'add-login' }, (event) => dashboard.onEvent(event, tree));
  dashboard.onEvent({ kind: 'header' }, tree);
  dashboard.stop('running', undefined, tree);
  // Still running, so the footer keeps offering the live keys rather than the settled press-any-key.
  assert.equal(dashboard.render(SIZE).hints, '↑↓ scroll notes · ctrl-c stop');
});

test('onKey pops only once the run has finished', () => {
  const dashboard = new RunDashboardView();
  assert.deepEqual(dashboard.onKey({ name: 'char', value: 'x' }), { type: 'none' });
  const tree = new RunTree([], { title: 'add-login' }, (event) => dashboard.onEvent(event, tree));
  dashboard.stop('done', undefined, tree);
  assert.deepEqual(dashboard.onKey({ name: 'char', value: 'x' }), { type: 'pop' });
});

/** Fills the notes buffer with identifiable lines: note 1 .. note n, oldest first. */
function withNotes(count: number): RunDashboardView {
  const dashboard = new RunDashboardView();
  for (let i = 1; i <= count; i++) dashboard.log(`note ${i}`);
  return dashboard;
}

test('the notes section follows the newest line until the user scrolls back', () => {
  const dashboard = withNotes(50);
  const shown = textOf(dashboard).join('\n');
  assert.match(shown, /note 50/, 'the tail must be visible by default');
  assert.doesNotMatch(shown, /note 1\b/);

  dashboard.render(SIZE); // establishes the page size onKey scrolls by
  for (let i = 0; i < 5; i++) dashboard.onKey({ name: 'up' });
  const scrolled = textOf(dashboard).join('\n');
  assert.match(scrolled, /note 40/, 'five lines back from the tail must now be in view');
  assert.doesNotMatch(scrolled, /note 50/);
  assert.match(scrolled, /notes 40-45 of 50/, 'a scrolled window states its position');
});

test('scrolling back to the bottom resumes following new notes', () => {
  const dashboard = withNotes(50);
  dashboard.render(SIZE);
  dashboard.onKey({ name: 'pageup' });
  assert.doesNotMatch(textOf(dashboard).join('\n'), /note 50/);

  for (let i = 0; i < NOTE_ROWS; i++) dashboard.onKey({ name: 'down' });
  assert.match(textOf(dashboard).join('\n'), /note 50/, 'reaching the bottom must unpin the window');

  dashboard.log('note 51');
  assert.match(textOf(dashboard).join('\n'), /note 51/, 'and new notes must appear again');
});

test('a pinned window stays put while new notes arrive', () => {
  const dashboard = withNotes(50);
  dashboard.render(SIZE);
  dashboard.onKey({ name: 'up' });
  const before = textOf(dashboard).join('\n');
  dashboard.log('note 51');
  assert.equal(textOf(dashboard).join('\n').includes('note 49'), before.includes('note 49'));
  assert.doesNotMatch(textOf(dashboard).join('\n'), /note 51/, 'the user reading back must not be yanked to the tail');
});

test('scrolling never runs off either end of the buffer', () => {
  const dashboard = withNotes(8);
  dashboard.render(SIZE);
  for (let i = 0; i < 20; i++) dashboard.onKey({ name: 'up' });
  assert.match(textOf(dashboard).join('\n'), /note 1\b/, 'scrolling up stops at the oldest note');
  for (let i = 0; i < 20; i++) dashboard.onKey({ name: 'down' });
  assert.match(textOf(dashboard).join('\n'), /note 8/, 'scrolling down stops at the newest');
});

test('one ctrl-c arms the stop and explains itself; the second requests the cancel', () => {
  const dispose = beginCancelScope();
  try {
    const dashboard = new RunDashboardView();
    assert.equal(dashboard.render(SIZE).hints, '↑↓ scroll notes · ctrl-c stop');

    dashboard.onKey(CTRL_C);
    assert.equal(isCancelRequested(), false, 'a single press must never stop a run');
    assert.equal(dashboard.render(SIZE).hints, 'ctrl-c again to stop this run');

    dashboard.onKey(CTRL_C);
    assert.equal(isCancelRequested(), true);
    assert.equal(dashboard.render(SIZE).hints, 'stopping after the current step…');
  } finally {
    dispose();
  }
});

test('a stray ctrl-c long after the first one only re-arms', async () => {
  const dispose = beginCancelScope();
  try {
    const dashboard = new RunDashboardView();
    dashboard.onKey(CTRL_C);
    await new Promise((resolve) => setTimeout(resolve, 2100)); // past CANCEL_ARM_MS
    dashboard.onKey(CTRL_C);
    assert.equal(isCancelRequested(), false, 'the arming window must expire');
    assert.equal(dashboard.render(SIZE).hints, 'ctrl-c again to stop this run');
  } finally {
    dispose();
  }
});

test('no key a running dashboard handles ever moves the view stack', () => {
  const dashboard = withNotes(3);
  for (const key of [CTRL_C, { name: 'up' } as const, { name: 'down' } as const, { name: 'escape' } as const, { name: 'char', value: 'q' } as const]) {
    assert.deepEqual(dashboard.onKey(key), { type: 'none' });
  }
});

test('runInDashboard wires the returned run action to a fresh dashboard and the given task', async () => {
  let ran = false;
  const action = runInDashboard('run', async () => {
    ran = true;
  });
  assert.equal(action.type, 'run');
  if (action.type !== 'run') return;
  assert.equal(action.label, 'run');
  await action.run({ redraw: () => {} });
  assert.ok(ran);
});

test('runInDashboard arms a cancel scope for the job and disposes it afterwards', async () => {
  let armedDuringTask = false;
  const action = runInDashboard('run', async () => {
    const dashboard = action.type === 'run' ? (action.view as RunDashboardView) : undefined;
    dashboard?.onKey(CTRL_C);
    dashboard?.onKey(CTRL_C);
    armedDuringTask = isCancelRequested();
  });
  if (action.type !== 'run') return;

  await action.run({ redraw: () => {} });
  assert.equal(armedDuringTask, true, 'the dashboard must be able to cancel its own job');
  assert.equal(isCancelRequested(), false, 'the scope must be disposed once the job settles');
});
