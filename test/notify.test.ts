import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chimeCommands, maybeChime, setCompletionSound, type ChimeSpawner } from '../src/ui/notify.js';

function fakeSpawner(): { spawner: ChimeSpawner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawner: ChimeSpawner = (cmd, args) => {
    calls.push({ cmd, args });
    return { on: () => undefined, unref: () => undefined };
  };
  return { spawner, calls };
}

/** Runs fn with the module-level enabled flag set, always restoring the silent default other test files rely on. */
function withSoundEnabled(fn: () => void): void {
  setCompletionSound(true);
  try {
    fn();
  } finally {
    setCompletionSound(false);
  }
}

test('chimeCommands lists each platform\'s bundled soft sounds in fallback order', () => {
  assert.deepEqual(chimeCommands('darwin', false), [{ cmd: 'afplay', args: ['/System/Library/Sounds/Glass.aiff'] }]);
  assert.equal(chimeCommands('win32', false)[0]?.cmd, 'powershell');
  assert.deepEqual(
    chimeCommands('linux', true).map((c) => c.cmd),
    ['paplay', 'canberra-gtk-play'],
  );
  assert.deepEqual(
    chimeCommands('linux', false).map((c) => c.cmd),
    ['canberra-gtk-play'],
  );
  assert.deepEqual(chimeCommands('freebsd', false), []);
});

test('maybeChime falls through to the next player when spawning the first one fails', () => {
  withSoundEnabled(() => {
    const calls: string[] = [];
    const spawner: ChimeSpawner = (cmd) => {
      calls.push(cmd);
      return {
        // Simulate a missing binary: fire the error callback the way a failed spawn would.
        on: (_event, cb) => (calls.length === 1 ? cb() : undefined),
        unref: () => undefined,
      };
    };
    maybeChime('done', spawner, true);
    assert.ok(calls.length >= 1);
    // On linux with the freedesktop chime installed, the canberra fallback runs second.
    if (process.platform === 'linux' && calls[0] === 'paplay') assert.equal(calls[1], 'canberra-gtk-play');
  });
});

test('maybeChime spawns a player once per settled run when enabled on a TTY', () => {
  withSoundEnabled(() => {
    for (const status of ['done', 'failed', 'escalated']) {
      const { spawner, calls } = fakeSpawner();
      maybeChime(status, spawner, true);
      assert.equal(calls.length, 1, `status "${status}"`);
    }
  });
});

test('maybeChime stays silent for an interrupted run (the user is already at the keyboard)', () => {
  withSoundEnabled(() => {
    const { spawner, calls } = fakeSpawner();
    maybeChime('interrupted', spawner, true);
    assert.equal(calls.length, 0);
  });
});

test('maybeChime stays silent when disabled or off-TTY (tests, CI, piped output)', () => {
  const { spawner, calls } = fakeSpawner();
  setCompletionSound(false);
  maybeChime('done', spawner, true); // disabled
  withSoundEnabled(() => maybeChime('done', spawner, false)); // enabled but not a TTY
  assert.equal(calls.length, 0);
});
