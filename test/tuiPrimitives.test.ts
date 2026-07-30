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
import {
  applyFilterKey,
  applyNav,
  clampIndex,
  firstSelectable,
  matchesFilter,
  moveIndex,
  moveToSelectable,
  navIntent,
  NO_FILTER,
  viewportWindow,
} from '../src/ui/tui/list.js';
import { applyKey, createInput, renderInput } from '../src/ui/tui/textInput.js';
import { frame, innerSize, selectionRow, FRAME_CHROME_ROWS } from '../src/ui/tui/chrome.js';

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

test('an overlong hint strip is clipped but keeps the frame corners, rather than degrading to a bare rule', () => {
  const size = { columns: 40, rows: 3 };
  const rows = frame({ title: 'pipeline-worker · sessions', body: [], hints: 'j/k move · ⏎ open · r resume · v review · y url · / filter · q back' }, size);
  const bottom = plainText(rows[rows.length - 1]);
  assert.equal(bottom.length, size.columns);
  assert.ok(bottom.startsWith('└'), bottom);
  assert.ok(bottom.endsWith('┘'), bottom);
  // The head of the strip survives; the tail is marked as clipped.
  assert.ok(bottom.includes('j/k move'), bottom);
  assert.ok(bottom.includes('…'), bottom);
});

test('a row occupies the same columns focused or not, so the list does not shift sideways under the cursor', () => {
  const content = [seg(' branch-name')];
  const selected = selectionRow(content, 20, true);
  const plain = selectionRow(content, 20, false);
  assert.equal(plainText(selected).length, 20);
  assert.equal(plainText(plain).length, 20);
  assert.ok(plainText(selected).startsWith('▐'));
  assert.ok(plainText(selected).endsWith('▌'));
  // Same text, different affordance — the bars replace the padding, never the content.
  assert.equal(plainText(selected).slice(1, -1), plainText(plain).slice(1, -1));
});

test('the selected row bolds its content, including segments that carried their own color', () => {
  // Only the caller's own segments — fitLine's padding is blank, so its style is moot.
  const content = selectionRow([seg('a'), seg('b', { role: 'green' })], 10, true).filter((part) => part.text.trim() !== '');
  assert.deepEqual(
    content.map((part) => part.text),
    ['▐', 'a', 'b', '▌'],
  );
  assert.ok(content.every((part) => part.bold));
  assert.equal(content.find((part) => part.text === 'b')?.role, 'green', 'selection must not repaint a status color');
  assert.equal(
    selectionRow([seg('a')], 10, false).some((part) => part.bold),
    false,
  );
});

test('selectionRow truncates content that would overrun the row rather than pushing the closing bar out', () => {
  const row = selectionRow([seg('an extremely long branch name')], 12, true);
  assert.equal(plainText(row).length, 12);
  assert.ok(plainText(row).endsWith('▌'));
});

test('navIntent accepts the vim set alongside the arrow set', () => {
  assert.deepEqual(navIntent({ name: 'char', value: 'j' }), { kind: 'move', delta: 1 });
  assert.deepEqual(navIntent({ name: 'down' }), { kind: 'move', delta: 1 });
  assert.deepEqual(navIntent({ name: 'char', value: 'k' }), { kind: 'move', delta: -1 });
  assert.deepEqual(navIntent({ name: 'up' }), { kind: 'move', delta: -1 });
  assert.deepEqual(navIntent({ name: 'char', value: 'g' }), { kind: 'first' });
  assert.deepEqual(navIntent({ name: 'char', value: 'G' }), { kind: 'last' });
});

test('ctrl-d and ctrl-u page by the caller\'s viewport, leaving plain d free for the settings editor', () => {
  assert.deepEqual(navIntent({ name: 'ctrl', value: 'd' }, 7), { kind: 'move', delta: 7 });
  assert.deepEqual(navIntent({ name: 'ctrl', value: 'u' }, 7), { kind: 'move', delta: -7 });
  assert.equal(navIntent({ name: 'char', value: 'd' }), undefined);
});

test('navIntent ignores keys that are not navigation, so a view can bind them itself', () => {
  assert.equal(navIntent({ name: 'char', value: 'r' }), undefined);
  assert.equal(navIntent({ name: 'enter' }), undefined);
  assert.equal(navIntent({ name: 'ctrl', value: 'c' }), undefined);
});

test('single steps wrap at the ends but page jumps clamp, so ctrl-d at the bottom stays at the bottom', () => {
  assert.equal(applyNav({ kind: 'move', delta: 1 }, 4, 5), 0);
  assert.equal(applyNav({ kind: 'move', delta: -1 }, 0, 5), 4);
  assert.equal(applyNav({ kind: 'move', delta: 10 }, 4, 5), 4);
  assert.equal(applyNav({ kind: 'move', delta: -10 }, 0, 5), 0);
  assert.equal(applyNav({ kind: 'first' }, 3, 5), 0);
  assert.equal(applyNav({ kind: 'last' }, 1, 5), 4);
  assert.equal(applyNav({ kind: 'last' }, 0, 0), 0);
});

test('the filter opens on /, collects characters, and keeps its query after enter closes the input', () => {
  const opened = applyFilterKey(NO_FILTER, { name: 'char', value: '/' });
  assert.deepEqual(opened, { typing: true, query: '' });
  const typed = applyFilterKey(opened!, { name: 'char', value: 'a' });
  assert.deepEqual(typed, { typing: true, query: 'a' });
  // ⏎ hands the keyboard back to the list without dropping the filter.
  assert.deepEqual(applyFilterKey(typed!, { name: 'enter' }), { typing: false, query: 'a' });
});

test('escape abandons the filter entirely, and a second / is a literal character once typing', () => {
  const typing = { typing: true, query: 'feat' };
  assert.deepEqual(applyFilterKey(typing, { name: 'escape' }), NO_FILTER);
  assert.deepEqual(applyFilterKey(typing, { name: 'char', value: '/' }), { typing: true, query: 'feat/' });
  assert.deepEqual(applyFilterKey(typing, { name: 'backspace' }), { typing: true, query: 'fea' });
  assert.deepEqual(applyFilterKey(typing, { name: 'ctrl', value: 'u' }), { typing: true, query: '' });
});

test('a closed filter passes non-/ keys back to the view instead of swallowing them', () => {
  assert.equal(applyFilterKey(NO_FILTER, { name: 'char', value: 'r' }), undefined);
  assert.equal(applyFilterKey(NO_FILTER, { name: 'down' }), undefined);
  // 'r' would be a command on the sessions list, but while typing it is a query character.
  assert.deepEqual(applyFilterKey({ typing: true, query: '' }, { name: 'char', value: 'r' }), { typing: true, query: 'r' });
});

test('filter matching is case-insensitive substring, and an empty query matches everything', () => {
  assert.equal(matchesFilter('feat/Worktree-resume', 'worktree'), true);
  assert.equal(matchesFilter('feat/worktree', 'WORK'), true);
  assert.equal(matchesFilter('feat/worktree', 'ftw'), false);
  assert.equal(matchesFilter('anything', ''), true);
});
