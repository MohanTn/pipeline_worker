import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeRenderer, fitToHeight, type OutStream } from '../src/ui/treeRenderer.js';
import { RunTree, type TreeRow } from '../src/ui/runTree.js';

// eslint-disable-next-line no-control-regex -- matches the renderer's own erase-region escape sequence
const ERASE_REGION_RE = /^\x1b\[\d+A\r\x1b\[J$/;

const SKELETON = [
  { id: 'capture', label: 'capture', detail: 'staged + unstaged diff' },
  { id: 'ci-watch', label: 'ci-watch', detail: 'watch CI' },
  { id: 'merge', label: 'merge', detail: 'auto-merge + sync' },
];

/** A fake TTY stream with fixed geometry: records every write, and lets tests fire a resize. */
class FakeStream implements OutStream {
  writes: string[] = [];
  columns: number | undefined = 80;
  rows: number | undefined = 24;
  private resizeListeners: Array<() => void> = [];

  write(text: string): void {
    this.writes.push(text);
  }

  on(event: 'resize', listener: () => void): void {
    if (event === 'resize') this.resizeListeners.push(listener);
  }

  off(event: 'resize', listener: () => void): void {
    if (event === 'resize') this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
  }

  fireResize(): void {
    for (const listener of this.resizeListeners) listener();
  }

  /** All output joined, for substring/regex assertions on the visible text. */
  text(): string {
    return this.writes.join('');
  }
}

interface Rig {
  out: FakeStream;
  renderer: TreeRenderer;
  tree: RunTree;
}

function makeRig(skeleton = SKELETON, columns = 80, rows = 24): Rig {
  const out = new FakeStream();
  out.columns = columns;
  out.rows = rows;
  const renderer = new TreeRenderer(out);
  const tree = new RunTree(skeleton, { title: 'add-login', worktreeShortId: 'a91f' }, (event) => renderer.onEvent(event, tree));
  renderer.onEvent({ kind: 'header' }, tree);
  return { out, renderer, tree };
}

/**
 * attach() monkey-patches the global console.log/error/warn, restored only
 * by stop() — and node:test runs every file in one process, so a rig left
 * un-stopped would leak the patched console into whichever test runs next.
 * Every test must go through this wrapper so cleanup happens even on failure.
 */
function withRig(fn: (rig: Rig) => void, skeleton = SKELETON, columns = 80, rows = 24): void {
  const rig = makeRig(skeleton, columns, rows);
  try {
    fn(rig);
  } finally {
    rig.renderer.stop('done', undefined, rig.tree);
  }
}

test('the initial frame shows every skeleton step pending with the ○ glyph, and hides the cursor', () => {
  withRig(({ out }) => {
    assert.ok(out.writes[0].includes('\x1b[?25l'));
    const text = out.text();
    assert.match(text, /pipeline-worker · add-login · worktree a91f · running/);
    assert.match(text, /○ capture/);
    assert.match(text, /○ ci-watch/);
    assert.match(text, /○ merge/);
  });
});

test('start/finish repaint immediately with the right glyph and figures', () => {
  withRig(({ out, tree }) => {
    tree.start('capture', { detail: 'reading the diff' });
    assert.match(out.text(), /capture\s+reading the diff/);

    tree.finish('capture', 'done');
    assert.match(out.text(), /✓ capture\s+reading the diff\s+0\.0s/);
  });
});

test('a failed step renders the ✗ glyph', () => {
  withRig(({ out, tree }) => {
    tree.start('ci-watch');
    tree.finish('ci-watch', 'failed', { detail: 'escalated to a human' });
    assert.match(out.text(), /✗ ci-watch\s+escalated to a human/);
  });
});

test('a skipped step renders dimmed with the – glyph', () => {
  withRig(({ out, tree }) => {
    tree.finish('merge', 'skipped', { detail: 'auto-merge disabled' });
    assert.match(out.text(), /– merge\s+auto-merge disabled/);
  });
});

test('no emitted line exceeds the terminal width, even with a long detail string', () => {
  withRig(
    ({ out, tree }) => {
      tree.start('capture', { detail: 'a very long detail string that would otherwise overflow the eighty column terminal by a wide margin' });
      for (const write of out.writes) {
        for (const line of write.split('\n')) {
          // Strip ANSI escapes before measuring — they're zero-width on screen.
          // eslint-disable-next-line no-control-regex
          const visible = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
          assert.ok(visible.length <= 39, `line exceeded width 39: "${visible}" (${visible.length})`);
        }
      }
    },
    SKELETON,
    39,
  );
});

test('each repaint erases exactly as many lines as the previous frame emitted', () => {
  withRig(({ out, tree }) => {
    out.writes = []; // drop the initial-attach frame; measure only the next repaint
    tree.start('capture');
    const eraseSequences = out.writes.filter((w) => ERASE_REGION_RE.test(w));
    assert.equal(eraseSequences.length, 1);
    // Header + 3 skeleton rows were painted before this event.
    assert.equal(eraseSequences[0], '\x1b[4A\r\x1b[J');
  });
});

test('log() erases the region, writes the text into scrollback, then repaints beneath it', () => {
  withRig(({ out, renderer }) => {
    out.writes = [];
    renderer.log('  agent: fixed the failing test');

    const eraseIndex = out.writes.findIndex((w) => ERASE_REGION_RE.test(w));
    const logIndex = out.writes.findIndex((w) => w.includes('agent: fixed the failing test'));
    assert.ok(eraseIndex >= 0 && logIndex > eraseIndex, 'erase must precede the log text');
    // A repaint follows the log line — the header appears again after it.
    const repaintIndex = out.writes.findIndex((w, i) => i > logIndex && w.includes('pipeline-worker · add-login'));
    assert.ok(repaintIndex > logIndex);
  });
});

test('a burst of several log() calls repaints exactly once per call, not once per tree event', () => {
  withRig(({ out, renderer }) => {
    out.writes = [];
    renderer.log('line one');
    renderer.log('line two');
    renderer.log('line three');
    const headerRepaints = out.writes.filter((w) => w.includes('pipeline-worker · add-login')).length;
    assert.equal(headerRepaints, 3);
  });
});

test('console.log/error/warn are intercepted while attached and restored on stop', () => {
  const before = console.log;
  withRig(({ out, renderer, tree }) => {
    // Once attached, console.log is no longer the pre-attach reference — it
    // routes through the renderer instead of the real stdout.
    assert.notEqual(console.log, before);
    console.log('this should be captured, not printed to the real stdout');
    assert.ok(out.text().includes('this should be captured'));
    renderer.stop('done', undefined, tree); // withRig's finally calls this again — must be idempotent
  });
  assert.equal(console.log, before);
});

test('stop() paints the final frame, restores the cursor, and further onEvent calls do not repaint', () => {
  withRig(({ out, renderer, tree }) => {
    tree.finish('capture', 'done');
    tree.finish('ci-watch', 'done');
    tree.finish('merge', 'done');
    out.writes = [];
    renderer.stop('done', 'MR #12 merged', tree);

    assert.match(out.text(), /MR #12 merged/);
    assert.ok(out.writes.some((w) => w.includes('\x1b[?25h')));

    const writesAfterStop = out.writes.length;
    tree.start('capture'); // late event after stop — must be a no-op
    assert.equal(out.writes.length, writesAfterStop);
  });
});

test('resize drops the stale region bookkeeping and repaints cleanly on the next event', () => {
  withRig(({ out, tree }) => {
    out.fireResize();
    assert.ok(out.writes.some((w) => w === '\n'));
    out.writes = [];
    tree.start('capture');
    // No erase-sequence referencing a stale line count that predates the resize.
    const eraseSequences = out.writes.filter((w) => ERASE_REGION_RE.test(w));
    assert.ok(eraseSequences.length <= 1);
  });
});

test('the header token total updates as soon as a step gains tokens', () => {
  withRig(({ out, tree }) => {
    tree.addTokens('capture', 1900);
    assert.match(out.text(), /1\.9k tok/);
  });
});

function makeRows(specs: Array<{ id: string; depth: number; status: 'done' | 'running' | 'pending' }>): TreeRow[] {
  return specs.map((s, i) => ({
    node: { id: s.id, label: s.id, detail: '', status: s.status, children: [] },
    depth: s.depth,
    isLast: s.depth === 0 ? [i === specs.length - 1] : [false, true],
  }));
}

test('fitToHeight leaves the tree untouched when it already fits', () => {
  const rows = makeRows([
    { id: 'capture', depth: 0, status: 'done' },
    { id: 'ci-watch', depth: 0, status: 'running' },
  ]);
  assert.deepEqual(fitToHeight(rows, 24), rows);
});

test('fitToHeight collapses a long run of finished attempt children, keeping the running step visible', () => {
  const children = Array.from({ length: 6 }, (_, i) => ({ id: `ci-watch/fix-${i + 1}`, depth: 1, status: 'done' as const }));
  const rows = makeRows([{ id: 'ci-watch', depth: 0, status: 'running' }, ...children]);
  const display = fitToHeight(rows, 5); // header(1) + budget(4)

  const summary = display.find((r) => 'summary' in r);
  assert.ok(summary && 'summary' in summary && /earlier attempts/.test(summary.summary));
  // The parent and the most recent finished child stay visible for context.
  assert.ok(display.some((r) => !('summary' in r) && r.node.id === 'ci-watch'));
  assert.ok(display.some((r) => !('summary' in r) && r.node.id === 'ci-watch/fix-6'));
});

test('fitToHeight falls back to keeping the newest rows when collapsing still does not fit', () => {
  const rows = makeRows(Array.from({ length: 20 }, (_, i) => ({ id: `step-${i}`, depth: 0, status: 'done' as const })));
  const display = fitToHeight(rows, 5);
  assert.ok(display.length <= 4);
  assert.ok(!('summary' in display[display.length - 1]) && (display[display.length - 1] as TreeRow).node.id === 'step-19');
});
