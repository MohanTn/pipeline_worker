import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineRenderer } from '../src/ui/renderer.js';
import { RunTree } from '../src/ui/runTree.js';

const SKELETON = [
  { id: 'capture', label: 'capture', detail: 'staged + unstaged diff' },
  { id: 'merge', label: 'merge', detail: 'auto-merge + sync' },
];

function makeRig(): { lines: string[]; renderer: LineRenderer; tree: RunTree } {
  const lines: string[] = [];
  const renderer = new LineRenderer((line) => lines.push(line));
  const tree = new RunTree(SKELETON, { title: 'add-login' }, (event) => renderer.onEvent(event, tree));
  return { lines, renderer, tree };
}

test('a started step prints a bold headline and its detail', () => {
  const { lines, tree } = makeRig();
  tree.start('capture', { detail: 'reading the diff' });
  assert.ok(lines.some((l) => l.includes('capture')));
  assert.ok(lines.some((l) => l.includes('reading the diff')));
});

test('a finished step with no tokens omits the token segment entirely — absence means unknown, never zero', () => {
  const { lines, tree } = makeRig();
  tree.start('capture');
  tree.finish('capture', 'done');
  const finishLine = lines.find((l) => l.includes('✓') && l.includes('capture'))!;
  assert.ok(finishLine);
  assert.doesNotMatch(finishLine, /tok/);
});

test('a finished step with known tokens includes them alongside the duration', () => {
  const { lines, tree } = makeRig();
  tree.start('capture');
  tree.addTokens('capture', 1900);
  tree.finish('capture', 'done');
  const finishLine = lines.find((l) => l.includes('✓') && l.includes('capture'))!;
  assert.match(finishLine, /1\.9k tok/);
});

test('a failed step prints the ✗ glyph', () => {
  const { lines, tree } = makeRig();
  tree.start('ci-watch');
  tree.finish('ci-watch', 'failed', { detail: 'escalated to a human' });
  assert.ok(lines.some((l) => l.includes('✗') && l.includes('escalated to a human')));
});

test('a skipped step is marked (skipped) with its reason', () => {
  const { lines, tree } = makeRig();
  tree.finish('merge', 'skipped', { detail: 'config.autoMergeOnGreen is disabled' });
  assert.ok(lines.some((l) => l.includes('(skipped)') && l.includes('config.autoMergeOnGreen is disabled')));
});

test('stop("running") is a no-op — only a terminal status prints a final line', () => {
  const { lines, renderer, tree } = makeRig();
  renderer.stop('running', undefined, tree);
  assert.deepEqual(lines, []);
});

test('stop("done") prints the total run tokens when any were spent, and omits the figure otherwise', () => {
  const { lines, renderer, tree } = makeRig();
  tree.addTokens('capture', 4400);
  renderer.stop('done', 'MR #12 merged', tree);
  assert.ok(lines.some((l) => l.includes('Done') && l.includes('4.4k tok')));
  assert.ok(lines.some((l) => l.includes('MR #12 merged')));

  const rig2 = makeRig();
  rig2.renderer.stop('done', undefined, rig2.tree);
  assert.ok(rig2.lines.some((l) => l.includes('Done') && !l.includes('tok')));
});

test('stop("escalated") and stop("failed") print their own distinct final line', () => {
  const escalated = makeRig();
  escalated.renderer.stop('escalated', 'see the MR/PR comment', escalated.tree);
  assert.ok(escalated.lines.some((l) => l.includes('Stopped for human review')));

  const failed = makeRig();
  failed.renderer.stop('failed', 'build failed', failed.tree);
  assert.ok(failed.lines.some((l) => l.includes('Run failed')));
});
