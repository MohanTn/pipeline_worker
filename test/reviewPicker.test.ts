import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewPickerView, applyEditorKey, createEditor, editedLine, editorText, initialRows, selectedFindings } from '../src/ui/tui/views/reviewPicker.js';
import { pickerAvailable } from '../src/ui/tui/reviewSession.js';
import { plainText } from '../src/ui/tui/line.js';
import { parseKeys } from '../src/ui/tui/keys.js';
import type { Action } from '../src/ui/tui/view.js';
import type { FindingCandidate, SelectableFinding } from '../src/review/selection.js';
import type { ReviewFinding } from '../src/review/types.js';

const SIZE = { columns: 80, rows: 20 };

function candidate(overrides: Partial<ReviewFinding> = {}, status: FindingCandidate['status'] = 'new', lastTurn?: number): FindingCandidate {
  const finding: ReviewFinding = { file: 'app.ts', line: 1, severity: 'MAJOR', comment: '### Bad\n\nfix it', ...overrides };
  return { finding, key: `${finding.file}:${finding.line}:key`, status, lastTurn };
}

/** Drives the view the way the app loop does: real byte sequences through the real parser. */
function press(view: ReviewPickerView, keys: string): Action {
  let action: Action = { type: 'none' };
  for (const key of parseKeys(keys)) action = view.onKey(key) as Action;
  return action;
}

function pickerWith(candidates: FindingCandidate[], turn = 1): { view: ReviewPickerView; result: () => { called: boolean; selected: SelectableFinding[] | undefined } } {
  let called = false;
  let selected: SelectableFinding[] | undefined;
  const view = new ReviewPickerView(turn, candidates, (result) => {
    called = true;
    selected = result;
  });
  return { view, result: () => ({ called, selected }) };
}

test('new findings start checked and previously ignored ones do not', () => {
  const rows = initialRows([candidate(), candidate({ line: 2 }, 'ignored', 1), candidate({ line: 3 }, 'seen', 1)]);
  assert.deepEqual(rows.map((row) => row.checked), [true, false, false]);
});

test('submitting straight away posts every new finding — the pre-picker behavior', () => {
  const { view, result } = pickerWith([candidate(), candidate({ line: 2 })]);
  const action = press(view, 's');
  assert.deepEqual(action, { type: 'quit' });
  assert.deepEqual(result().selected?.map((finding) => finding.line), [1, 2]);
});

test('space toggles a row, a/n check and uncheck the visible ones', () => {
  const { view, result } = pickerWith([candidate(), candidate({ line: 2 })]);
  press(view, ' ');
  press(view, 's');
  assert.deepEqual(result().selected?.map((finding) => finding.line), [2], 'space unchecked the focused row');

  const second = pickerWith([candidate(), candidate({ line: 2 })]);
  press(second.view, 'n');
  press(second.view, 's');
  assert.deepEqual(second.result().selected, []);

  const third = pickerWith([candidate({}, 'ignored', 1), candidate({ line: 2 }, 'ignored', 1)]);
  press(third.view, 'a');
  press(third.view, 's');
  assert.deepEqual(third.result().selected?.length, 2, 'a checks even the rows an earlier round ignored');
});

test('q cancels: nothing is selected, and the caller is told it was a cancel rather than an empty pick', () => {
  const { view, result } = pickerWith([candidate()]);
  assert.deepEqual(press(view, 'q'), { type: 'quit' });
  assert.equal(result().called, true);
  assert.equal(result().selected, undefined);
});

test('findings an earlier round posted are hidden until d shows them', () => {
  const { view } = pickerWith([candidate(), candidate({ line: 2 }, 'seen', 1)], 2);
  const before = view.render(SIZE).body.map(plainText).join('\n');
  assert.doesNotMatch(before, /app\.ts:2/);
  press(view, 'd');
  const after = view.render(SIZE).body.map(plainText).join('\n');
  assert.match(after, /app\.ts:2/);
  assert.match(after, /posted in turn 1/);
});

test('the header names the round and the split it is showing', () => {
  const { view } = pickerWith([candidate(), candidate({ line: 2 }, 'seen', 1), candidate({ line: 3 }, 'ignored', 1)], 2);
  const header = plainText(view.render(SIZE).body[0]);
  assert.match(header, /Turn 2/);
  assert.match(header, /1 new · 1 seen · 1 ignored/);
  assert.match(header, /1 selected/);
});

test('⏎ opens the whole comment, esc returns to the list', () => {
  const { view } = pickerWith([candidate({ comment: '### Hard-coded secret\n\nMove it to an env var.' })]);
  press(view, '\r');
  const detail = view.render(SIZE);
  assert.equal(detail.title, 'review · comment');
  assert.match(detail.body.map(plainText).join('\n'), /Move it to an env var\./);
  press(view, '\x1b');
  assert.equal(view.render(SIZE).title, 'review · pick comments');
});

test('e edits the body, and ctrl-s makes the edited text what gets posted', () => {
  const { view, result } = pickerWith([candidate()]);
  press(view, 'e');
  assert.equal(view.render(SIZE).title, 'review · edit comment');
  press(view, '\x05!');  // ctrl-e (end of line) is not bound; the char lands at the caret
  press(view, '\x13'); // ctrl-s
  press(view, 's');

  const selected = result().selected ?? [];
  assert.equal(selected.length, 1);
  assert.equal(selected[0].edited, true);
  assert.match(selected[0].body ?? '', /!/);
  assert.equal(selected[0].comment, '### Bad\n\nfix it', 'the agent text is kept as the finding identity');
});

test('esc in the editor discards the edit', () => {
  const { view, result } = pickerWith([candidate()]);
  press(view, 'e');
  press(view, 'xyz');
  press(view, '\x1b');
  press(view, 's');
  const selected = result().selected;
  assert.equal(selected?.length, 1, 'esc leaves the editor, not the picker');
  assert.equal(selected?.[0].body, undefined);
  assert.equal(selected?.[0].edited, undefined);
});

test('an edit saved empty unchecks the row, so nothing is posted for it', () => {
  const { view, result } = pickerWith([candidate({ comment: 'x' })]);
  press(view, 'e');
  press(view, '\x15'); // ctrl-u clears the line
  press(view, '\x13'); // ctrl-s
  press(view, 's');
  assert.deepEqual(result().selected, []);
});

test('the editor keeps paragraphs: enter splits a line, backspace at column 0 joins it back', () => {
  let state = createEditor('one\ntwo');
  assert.equal(state.lines.length, 2);
  state = applyEditorKey(state, { name: 'end' }).state;
  state = applyEditorKey(state, { name: 'enter' }).state;
  state = applyEditorKey(state, { name: 'char', value: 'X' }).state;
  assert.equal(editorText(state), 'one\nX\ntwo');
  state = applyEditorKey(state, { name: 'home' }).state;
  state = applyEditorKey(state, { name: 'backspace' }).state;
  assert.equal(editorText(state), 'oneX\ntwo');
  assert.equal(applyEditorKey(state, { name: 'ctrl', value: 's' }).result, 'save');
  assert.equal(applyEditorKey(state, { name: 'escape' }).result, 'cancel');
});

test('the caret stays on screen while typing past the terminal width', () => {
  const value = 'x'.repeat(200);
  const line = editedLine({ value, cursor: 180 }, 40);
  const caret = line.find((part) => part.invert);
  assert.ok(caret, 'the drawn caret must survive the horizontal scroll');
  assert.ok(plainText(line).length <= 40, `the windowed line must fit the frame, got ${plainText(line).length}`);
  assert.deepEqual(editedLine({ value: 'short', cursor: 5 }, 40).map((part) => part.text).join(''), 'short ', 'a line that fits is not scrolled');
});

test('selectedFindings drops unchecked rows and rows edited down to whitespace', () => {
  const rows = initialRows([candidate(), candidate({ line: 2 }), candidate({ line: 3 })]);
  rows[1].checked = false;
  rows[2].body = '   ';
  rows[2].edited = true;
  assert.deepEqual(selectedFindings(rows).map((finding) => finding.line), [1]);
});

test('the picker only runs where nothing else owns the terminal', () => {
  assert.equal(pickerAvailable(true, true, false), true);
  assert.equal(pickerAvailable(false, true, false), false, 'piped stdin cannot answer a prompt');
  assert.equal(pickerAvailable(true, false, false), false);
  assert.equal(pickerAvailable(true, true, true), false, 'inside the TUI the app loop already holds raw mode');
});
