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

const SIZE = { columns: 90, rows: 24 };

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

test('log() lines from steps.ts (note/announce) appear above the tree', () => {
  const dashboard = new RunDashboardView();
  dashboard.log('  agent: fixed the failing test');
  assert.ok(textOf(dashboard).some((line) => line.includes('agent: fixed the failing test')));
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
  assert.equal(dashboard.render(SIZE).hints, 'running…');
});

test('onKey pops only once the run has finished', () => {
  const dashboard = new RunDashboardView();
  assert.deepEqual(dashboard.onKey({ name: 'char', value: 'x' }), { type: 'none' });
  const tree = new RunTree([], { title: 'add-login' }, (event) => dashboard.onEvent(event, tree));
  dashboard.stop('done', undefined, tree);
  assert.deepEqual(dashboard.onKey({ name: 'char', value: 'x' }), { type: 'pop' });
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
