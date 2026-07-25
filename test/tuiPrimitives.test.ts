/**
 * The TUI's pure building blocks: key decoding, line fitting, list cursors and
 * the text field. Everything here is a pure function or a tiny state machine,
 * so the terminal behaviour the rest of the TUI depends on is pinned without a
 * terminal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from '../src/ui/tui/keys.js';
import { fitLine, plainText, renderLine, seg, wrap } from '../src/ui/tui/line.js';
import { clampIndex, firstSelectable, moveIndex, moveToSelectable, viewportWindow } from '../src/ui/tui/list.js';
import { applyKey, createInput, renderInput } from '../src/ui/tui/textInput.js';
import { frame, innerSize, FRAME_CHROME_ROWS } from '../src/ui/tui/chrome.js';

test('parseKeys decodes the arrow keys from their CSI sequences', () => {
  assert.deepEqual(parseKeys('\x1b[A'), [{ name: 'up' }]);
  assert.deepEqual(parseKeys('\x1b[B'), [{ name: 'down' }]);
  assert.deepEqual(parseKeys('\x1b[C'), [{ name: 'right' }]);
  assert.deepEqual(parseKeys('\x1b[D'), [{ name: 'left' }]);
});

test('parseKeys decodes the SS3 arrow variant some terminals send in application mode', () => {
  assert.deepEqual(parseKeys('\x1bOA'), [{ name: 'up' }]);
});

test('parseKeys decodes the numeric CSI-tilde navigation keys', () => {
  assert.deepEqual(parseKeys('\x1b[3~'), [{ name: 'delete' }]);
  assert.deepEqual(parseKeys('\x1b[5~'), [{ name: 'pageup' }]);
  assert.deepEqual(parseKeys('\x1b[6~'), [{ name: 'pagedown' }]);
});

test('parseKeys maps enter, tab and both backspace spellings', () => {
  assert.deepEqual(parseKeys('\r'), [{ name: 'enter' }]);
  assert.deepEqual(parseKeys('\n'), [{ name: 'enter' }]);
  assert.deepEqual(parseKeys('\t'), [{ name: 'tab' }]);
  assert.deepEqual(parseKeys('\x7f'), [{ name: 'backspace' }]);
  assert.deepEqual(parseKeys('\b'), [{ name: 'backspace' }]);
});

test('parseKeys reports control characters as ctrl+letter', () => {
  assert.deepEqual(parseKeys('\x03'), [{ name: 'ctrl', value: 'c' }]);
  assert.deepEqual(parseKeys('\x15'), [{ name: 'ctrl', value: 'u' }]);
});

test('parseKeys treats a lone ESC as the escape key', () => {
  assert.deepEqual(parseKeys('\x1b'), [{ name: 'escape' }]);
});

test('parseKeys splits a chunk holding several keys, as a fast typist produces', () => {
  assert.deepEqual(parseKeys('ab\x1b[A\r'), [
    { name: 'char', value: 'a' },
    { name: 'char', value: 'b' },
    { name: 'up' },
    { name: 'enter' },
  ]);
});

test('parseKeys drops an unrecognized escape sequence instead of leaking its bytes as characters', () => {
  // A mouse/bracketed-paste sequence must not turn into a burst of keystrokes
  // that navigate the menus.
  assert.deepEqual(parseKeys('\x1b[200~'), []);
});

test('parseKeys consumes a sequence truncated by a chunk boundary without throwing', () => {
  assert.deepEqual(parseKeys('\x1b[1'), []);
});

test('fitLine pads a short line to exactly the requested width', () => {
  const fitted = fitLine([seg('hi')], 6);
  assert.equal(plainText(fitted), 'hi    ');
});

test('fitLine truncates an overlong line to exactly the width, marking the cut', () => {
  const fitted = fitLine([seg('abcdefghij')], 5);
  assert.equal(plainText(fitted), 'abcd…');
});

test('fitLine truncates across segment boundaries, keeping the total exact', () => {
  const fitted = fitLine([seg('abc'), seg('def'), seg('ghi')], 5);
  assert.equal(plainText(fitted), 'abcd…');
});

/** Drops SGR colour escapes so a styled line can be compared by its visible characters. */
function stripAnsi(text: string): string {
  return text.split(String.fromCharCode(27)).map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, ''))).join('');
}

test('renderLine measures width on the plain text, not on the escape codes', () => {
  // The styled result is longer than the width in bytes but not in columns —
  // the trap that shears a redrawn frame.
  const rendered = renderLine([seg('abcdefghij', { role: 'green' })], 5);
  assert.equal(stripAnsi(rendered), 'abcd…');
});

test('wrap breaks on spaces and hard-splits a word longer than the line', () => {
  assert.deepEqual(wrap('alpha beta gamma', 11), ['alpha beta', 'gamma']);
  assert.deepEqual(wrap('supercalifragilistic', 6), ['superc', 'alifra', 'gilist', 'ic']);
});

test('moveIndex wraps at both ends so a short menu never needs a held key', () => {
  assert.equal(moveIndex(0, -1, 4), 3);
  assert.equal(moveIndex(3, 1, 4), 0);
  assert.equal(moveIndex(0, 1, 4), 1);
});

test('moveIndex and clampIndex stay in range on an empty list', () => {
  assert.equal(moveIndex(0, 1, 0), 0);
  assert.equal(clampIndex(5, 0), 0);
  assert.equal(clampIndex(9, 3), 2);
});

test('viewportWindow scrolls only when the cursor would leave the window', () => {
  assert.deepEqual(viewportWindow(0, 10, 3, 0), { start: 0, end: 3 });
  assert.deepEqual(viewportWindow(2, 10, 3, 0), { start: 0, end: 3 });
  assert.deepEqual(viewportWindow(3, 10, 3, 0), { start: 1, end: 4 });
  assert.deepEqual(viewportWindow(0, 10, 3, 5), { start: 0, end: 3 });
});

test('viewportWindow clamps a stale start after the list shrinks', () => {
  assert.deepEqual(viewportWindow(1, 4, 3, 7), { start: 1, end: 4 });
});

test('moveToSelectable skips over group headings', () => {
  // rows: [heading, field, field, heading, field]
  const selectable = (i: number): boolean => i !== 0 && i !== 3;
  assert.equal(moveToSelectable(1, 1, 5, selectable), 2);
  assert.equal(moveToSelectable(2, 1, 5, selectable), 4);
  assert.equal(moveToSelectable(4, 1, 5, selectable), 1);
  assert.equal(moveToSelectable(1, -1, 5, selectable), 4);
});

test('moveToSelectable returns the original index when nothing is selectable, instead of spinning', () => {
  assert.equal(moveToSelectable(2, 1, 5, () => false), 2);
  assert.equal(firstSelectable(5, () => false), 0);
});

test('the text field inserts, deletes and moves at the cursor', () => {
  let state = createInput('abc');
  state = applyKey(state, { name: 'left' }).state;
  state = applyKey(state, { name: 'char', value: 'X' }).state;
  assert.equal(state.value, 'abXc');
  state = applyKey(state, { name: 'backspace' }).state;
  assert.equal(state.value, 'abc');
  state = applyKey(state, { name: 'home' }).state;
  state = applyKey(state, { name: 'delete' }).state;
  assert.equal(state.value, 'bc');
});

test('backspace at the start of the field is a no-op, not an underflow', () => {
  const state = applyKey(createInput(''), { name: 'backspace' }).state;
  assert.equal(state.value, '');
  assert.equal(state.cursor, 0);
});

test('ctrl-u clears the field, and other keys are reported unhandled so the view can bind them', () => {
  assert.equal(applyKey(createInput('abc'), { name: 'ctrl', value: 'u' }).state.value, '');
  assert.equal(applyKey(createInput('abc'), { name: 'enter' }).handled, false);
  assert.equal(applyKey(createInput('abc'), { name: 'ctrl', value: 'c' }).handled, false);
});

test('renderInput shows the placeholder for an empty field and a drawn caret otherwise', () => {
  assert.equal(plainText(renderInput(createInput(''), '(none)')), ' (none)');
  const painted = renderInput(createInput('ab'), '(none)');
  assert.equal(plainText(painted), 'ab ');
  // The caret is the inverted segment — the terminal cursor itself is hidden.
  assert.ok(painted.some((part) => part.invert));
});

test('frame fills the terminal exactly: every row is the full width, and there are as many rows as the terminal has', () => {
  const size = { columns: 40, rows: 10 };
  const rows = frame({ title: 'settings', body: [[seg('one')]], hints: 'q back' }, size);
  assert.equal(rows.length, size.rows);
  for (const row of rows) assert.equal(plainText(row).length, size.columns, `row: ${plainText(row)}`);
});

test('frame clips a body longer than the terminal rather than overflowing the screen', () => {
  const size = { columns: 30, rows: 6 };
  const body = Array.from({ length: 50 }, (_, i) => [seg(`row ${i}`)]);
  const rows = frame({ title: 't', body, hints: 'h' }, size);
  assert.equal(rows.length, size.rows);
  assert.equal(innerSize(size).rows, size.rows - FRAME_CHROME_ROWS);
});

test('frame survives a terminal too narrow for its own title, still producing exact-width rows', () => {
  const size = { columns: 8, rows: 4 };
  const rows = frame({ title: 'a very long title', body: [[seg('x')]], hints: 'a very long hint strip' }, size);
  for (const row of rows) assert.equal(plainText(row).length, size.columns);
});
