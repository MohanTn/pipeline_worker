import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunTree, type TreeEvent } from '../src/ui/runTree.js';

const SKELETON = [
  { id: 'capture', label: 'capture', detail: 'staged + unstaged diff' },
  { id: 'ci-watch', label: 'ci-watch', detail: 'watch CI' },
  { id: 'merge', label: 'merge', detail: 'auto-merge + sync' },
];

function makeTree(events: TreeEvent[] = []): RunTree {
  return new RunTree(SKELETON, { title: 'test-run' }, (event) => events.push(event));
}

test('RunTree starts every skeleton step pending and walks start → finish with a measured duration', () => {
  const tree = makeTree();
  assert.ok(tree.roots.every((node) => node.status === 'pending'));

  tree.start('capture', { detail: 'reading the diff' });
  assert.equal(tree.get('capture')?.status, 'running');
  assert.equal(tree.get('capture')?.detail, 'reading the diff');

  tree.finish('capture', 'done');
  assert.equal(tree.get('capture')?.status, 'done');
  assert.ok((tree.get('capture')?.durationMs ?? -1) >= 0);
});

test('RunTree finish("skipped") records the reason but no duration', () => {
  const tree = makeTree();
  tree.finish('merge', 'skipped', { detail: 'auto-merge disabled' });
  assert.equal(tree.get('merge')?.status, 'skipped');
  assert.equal(tree.get('merge')?.detail, 'auto-merge disabled');
  assert.equal(tree.get('merge')?.durationMs, undefined);
});

test('an operation on an unknown id materializes it as a top-level node instead of throwing', () => {
  const tree = makeTree();
  tree.start('never-declared');
  const node = tree.get('never-declared');
  assert.ok(node);
  assert.equal(node.status, 'running');
  assert.ok(tree.roots.includes(node));
});

test('dynamic children nest under their parent while it runs, and adding an existing id is a no-op', () => {
  const tree = makeTree();
  tree.start('ci-watch');
  tree.add('ci-watch', { id: 'ci-watch/fix-1', label: 'fix 1', detail: 'pipeline failed' });
  tree.add('ci-watch', { id: 'ci-watch/fix-1', label: 'DUPLICATE', detail: 'x' });

  const parent = tree.get('ci-watch');
  assert.equal(parent?.children.length, 1);
  assert.equal(parent?.children[0].label, 'fix 1');
});

test('attempt counters render data lives on the node', () => {
  const tree = makeTree();
  tree.add('ci-watch', { id: 'ci-watch/fix-2', label: 'fix 2', detail: '' });
  tree.start('ci-watch/fix-2', { attempt: 2, maxAttempts: 5 });
  assert.equal(tree.get('ci-watch/fix-2')?.attempt, 2);
  assert.equal(tree.get('ci-watch/fix-2')?.maxAttempts, 5);
});

test('addTokens accumulates per node and totalTokens sums nodes plus a seeded pre-resume total', () => {
  const tree = makeTree();
  tree.addTokens('capture', 400);
  tree.addTokens('capture', 100);
  tree.add('ci-watch', { id: 'ci-watch/fix-1', label: 'fix 1', detail: '' });
  tree.addTokens('ci-watch/fix-1', 4400);
  tree.seedTokens(1000);

  assert.equal(tree.get('capture')?.tokens, 500);
  assert.equal(tree.totalTokens(), 5900);
});

test('addTokens ignores non-positive and non-finite amounts — absence means unknown, never zero', () => {
  const tree = makeTree();
  tree.addTokens('capture', 0);
  tree.addTokens('capture', -5);
  tree.addTokens('capture', Number.NaN);
  assert.equal(tree.get('capture')?.tokens, undefined);
  assert.equal(tree.totalTokens(), 0);
});

test('flatten returns depth-first rows with last-sibling flags for branch glyphs', () => {
  const tree = makeTree();
  tree.add('ci-watch', { id: 'ci-watch/wait-1', label: 'wait', detail: '' });
  tree.add('ci-watch', { id: 'ci-watch/fix-1', label: 'fix 1', detail: '' });

  const rows = tree.flatten();
  assert.deepEqual(
    rows.map((r) => r.node.id),
    ['capture', 'ci-watch', 'ci-watch/wait-1', 'ci-watch/fix-1', 'merge'],
  );
  assert.deepEqual(rows.map((r) => r.depth), [0, 0, 1, 1, 0]);

  const wait = rows.find((r) => r.node.id === 'ci-watch/wait-1')!;
  const fix = rows.find((r) => r.node.id === 'ci-watch/fix-1')!;
  const merge = rows.find((r) => r.node.id === 'merge')!;
  assert.deepEqual(wait.isLast, [false, false]); // ci-watch isn't the last root; wait isn't the last child
  assert.deepEqual(fix.isLast, [false, true]);
  assert.deepEqual(merge.isLast, [true]);
});

test('every mutation emits a change event for the renderer', () => {
  const events: TreeEvent[] = [];
  const tree = makeTree(events);
  tree.start('capture');
  tree.update('capture', { detail: 'still reading' });
  tree.addTokens('capture', 10);
  tree.finish('capture', 'done');
  tree.setHeader({ title: 'renamed' });
  tree.add('ci-watch', { id: 'ci-watch/wait-1', label: 'wait', detail: '' });

  assert.deepEqual(
    events.map((e) => e.kind),
    ['start', 'update', 'tokens', 'finish', 'header', 'add'],
  );
  assert.equal(tree.header.title, 'renamed');
});
