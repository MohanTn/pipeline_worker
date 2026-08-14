/**
 * The screen `pipeline-worker review --branch <name>` shows before anything is
 * posted: every finding the agent produced, as a checkbox list the human
 * submits.
 *
 * Three modes, one view: the list (pick), the detail pane (read the whole
 * body), and the editor (rewrite it, or append to it, before it goes out). The
 * view is pure state + keys like every other TUI screen — the terminal work
 * lives in ui/tui/reviewSession.ts — so the whole interaction is testable by
 * feeding it keys.
 *
 * Findings an earlier round already posted are hidden rather than dropped:
 * `d` shows them, unchecked, for the rare case where re-posting is wanted.
 */

import { seg, wrap, type Line } from '../line.js';
import { selectionRow } from '../chrome.js';
import { applyNav, clampIndex, navIntent, viewportWindow } from '../list.js';
import { applyKey, createInput, renderInput, type InputState } from '../textInput.js';
import { HINT, hints, NONE, type Action, type RenderedView, type View } from '../view.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';
import type { FindingCandidate, SelectableFinding } from '../../../review/selection.js';
import type { MochaRole } from '../../theme.js';
import type { ReviewSeverity } from '../../../review/types.js';

const SEVERITY_ROLE: Record<ReviewSeverity, MochaRole> = { CRITICAL: 'red', MAJOR: 'yellow', MINOR: 'subtext0' };

/** One finding as the picker holds it: what the human checked, and the body as it currently reads. */
export interface PickerRow {
  candidate: FindingCandidate;
  checked: boolean;
  body: string;
  edited: boolean;
}

/**
 * Fresh findings start checked, so submitting straight away reproduces what
 * the command did before the picker existed. A finding an earlier round's
 * human unchecked stays unchecked — ignoring is sticky, but re-offered, not
 * permanent.
 */
export function initialRows(candidates: FindingCandidate[]): PickerRow[] {
  return candidates.map((candidate) => ({ candidate, checked: candidate.status === 'new', body: candidate.finding.comment, edited: false }));
}

/** The rows a submit turns into: unchecked rows and rows edited down to nothing are not comments. */
export function selectedFindings(rows: PickerRow[]): SelectableFinding[] {
  return rows
    .filter((row) => row.checked && row.body.trim() !== '')
    .map((row) => ({ ...row.candidate.finding, ...(row.edited ? { body: row.body, edited: true } : {}) }));
}

/** A multi-line buffer over textInput.ts's single-line reducer: one InputState for the focused row, plain strings for the rest. */
export interface EditorState {
  lines: string[];
  row: number;
  input: InputState;
}

export function createEditor(body: string): EditorState {
  const lines = body.split('\n');
  return { lines, row: 0, input: createInput(lines[0] ?? '') };
}

export function editorText(state: EditorState): string {
  return state.lines.map((line, index) => (index === state.row ? state.input.value : line)).join('\n');
}

function moveEditorRow(state: EditorState, delta: number): EditorState {
  const lines = state.lines.map((line, index) => (index === state.row ? state.input.value : line));
  const row = clampIndex(state.row + delta, lines.length);
  return { lines, row, input: createInput(lines[row] ?? '') };
}

function splitEditorLine(state: EditorState): EditorState {
  const { value, cursor } = state.input;
  const lines = state.lines.map((line, index) => (index === state.row ? value : line));
  lines.splice(state.row, 1, value.slice(0, cursor), value.slice(cursor));
  return { lines, row: state.row + 1, input: createInput(lines[state.row + 1]) };
}

/** Backspace at column 0 joins this line onto the previous one, with the caret left where the join happened. */
function joinEditorLine(state: EditorState): EditorState {
  const lines = state.lines.map((line, index) => (index === state.row ? state.input.value : line));
  const previous = lines[state.row - 1];
  const merged = previous + lines[state.row];
  lines.splice(state.row - 1, 2, merged);
  return { lines, row: state.row - 1, input: { value: merged, cursor: previous.length } };
}

/**
 * Folds one key into the editor. `ctrl-s` saves and `esc` discards — enter is
 * a newline here, since a review comment is markdown with paragraphs and a
 * suggestion block, not a one-line answer.
 */
// fallow-ignore-next-line complexity
export function applyEditorKey(state: EditorState, key: Key): { state: EditorState; result?: 'save' | 'cancel' } {
  if (key.name === 'ctrl' && key.value === 's') return { state, result: 'save' };
  if (key.name === 'escape') return { state, result: 'cancel' };
  if (key.name === 'enter') return { state: splitEditorLine(state) };
  if (key.name === 'up') return { state: moveEditorRow(state, -1) };
  if (key.name === 'down') return { state: moveEditorRow(state, 1) };
  if (key.name === 'backspace' && state.input.cursor === 0 && state.row > 0) return { state: joinEditorLine(state) };
  const { state: input, handled } = applyKey(state.input, key);
  return { state: handled ? { ...state, input } : state };
}

/**
 * The line being typed on, scrolled horizontally so the caret stays on screen.
 * A review comment's paragraphs are routinely wider than the terminal, and
 * fitLine would otherwise truncate the tail — including the caret — the moment
 * the text outgrew the frame, leaving the typist blind.
 */
export function editedLine(input: InputState, width: number): Line {
  if (input.value.length < width) return renderInput(input);
  const room = width - 1;
  const start = Math.max(0, Math.min(input.cursor - Math.floor(room / 2), input.value.length - room));
  return renderInput({ value: input.value.slice(start, start + room), cursor: input.cursor - start });
}

/** '[posted in turn 1]' / '[ignored in turn 2]' / '[new]' — why a row is checked or not. */
function statusTag(candidate: FindingCandidate): { text: string; role: MochaRole } {
  if (candidate.status === 'seen') return { text: `[posted in turn ${candidate.lastTurn ?? 1}]`, role: 'overlay1' };
  if (candidate.status === 'ignored') return { text: `[ignored in turn ${candidate.lastTurn ?? 1}]`, role: 'overlay1' };
  return { text: '[new]', role: 'green' };
}

/** The comment's first meaningful line, with a markdown heading's '#' dropped — that is the finding's title. */
function summarize(body: string): string {
  const first = body.split('\n').find((line) => line.trim() !== '') ?? '';
  return first.replace(/^#+\s*/, '').trim();
}

export class ReviewPickerView implements View {
  private readonly rows: PickerRow[];
  private index = 0;
  private windowStart = 0;
  private mode: 'list' | 'detail' | 'edit' = 'list';
  private detailOffset = 0;
  private showSeen = false;
  private editor: EditorState | undefined;

  constructor(
    private readonly turn: number,
    candidates: FindingCandidate[],
    private readonly done: (selected: SelectableFinding[] | undefined) => void,
  ) {
    this.rows = initialRows(candidates);
  }

  /** Rows the `d` toggle lets through — what the cursor indexes. */
  private visible(): PickerRow[] {
    return this.showSeen ? this.rows : this.rows.filter((row) => row.candidate.status !== 'seen');
  }

  private focused(): PickerRow | undefined {
    const visible = this.visible();
    return visible[clampIndex(this.index, visible.length)];
  }

  private header(): Line {
    const counts = { new: 0, seen: 0, ignored: 0 };
    for (const row of this.rows) counts[row.candidate.status] += 1;
    const checked = this.rows.filter((row) => row.checked).length;
    return [
      seg(`Turn ${this.turn}`, { bold: true }),
      seg(`  ${counts.new} new · ${counts.seen} seen · ${counts.ignored} ignored`, { role: 'overlay1' }),
      seg(`  ${checked} selected`, { role: 'mauve' }),
    ];
  }

  private row(row: PickerRow, selected: boolean, columns: number): Line {
    const tag = statusTag(row.candidate);
    const { file, line, severity } = row.candidate.finding;
    const content: Line = [
      seg(` ${row.checked ? '[x]' : '[ ]'} `, { role: row.checked ? 'green' : 'overlay1' }),
      seg(`${severity.padEnd(8)} `, { role: SEVERITY_ROLE[severity] }),
      seg(`${file}:${line}  `),
      seg(summarize(row.body), { role: 'subtext0' }),
      seg(` ${row.edited ? '[edited] ' : ''}${tag.text}`, { role: row.edited ? 'mauve' : tag.role }),
    ];
    return selectionRow(content, columns, selected);
  }

  private listBody(inner: Size): Line[] {
    const visible = this.visible();
    this.index = clampIndex(this.index, visible.length);
    if (visible.length === 0) return [this.header(), [], [seg('nothing left to post — every finding was already posted in an earlier round (d shows them)', { role: 'overlay1' })]];
    const listRows = Math.max(1, inner.rows - 2);
    const { start, end } = viewportWindow(this.index, visible.length, listRows, this.windowStart);
    this.windowStart = start;
    const body: Line[] = [this.header(), []];
    for (let i = start; i < end; i++) body.push(this.row(visible[i], i === this.index, inner.columns));
    return body;
  }

  private detailBody(inner: Size): Line[] {
    const row = this.focused();
    if (!row) return [[seg('no finding selected', { role: 'overlay1' })]];
    const { file, line, severity } = row.candidate.finding;
    const head: Line[] = [
      [seg(`${severity} `, { role: SEVERITY_ROLE[severity] }), seg(`${file}:${line}`, { bold: true }), seg(`  ${statusTag(row.candidate).text}`, { role: 'overlay1' })],
      [],
    ];
    const wrapped = wrap(row.body, inner.columns).map((text): Line => [seg(text)]);
    const room = Math.max(1, inner.rows - head.length);
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, wrapped.length - room));
    return [...head, ...wrapped.slice(this.detailOffset, this.detailOffset + room)];
  }

  private editBody(inner: Size): Line[] {
    const editor = this.editor;
    if (!editor) return [];
    const room = Math.max(1, inner.rows - 2);
    const { start, end } = viewportWindow(editor.row, editor.lines.length, room);
    const body: Line[] = [[seg('editing the comment — this text is what gets posted', { role: 'overlay1' })], []];
    for (let i = start; i < end; i++) body.push(i === editor.row ? editedLine(editor.input, inner.columns) : [seg(editor.lines[i])]);
    return body;
  }

  render(inner: Size): RenderedView {
    if (this.mode === 'edit') return { title: 'review · edit comment', body: this.editBody(inner), hints: hints('ctrl-s save', 'esc discard', HINT.clear) };
    if (this.mode === 'detail') return { title: 'review · comment', body: this.detailBody(inner), hints: hints(HINT.scroll, 'e edit', 'space toggle', 'esc back') };
    return { title: `review · pick comments`, body: this.listBody(inner), hints: hints(HINT.move, 'space toggle', 'a/n all/none', '⏎ read', 'e edit', 'd seen', 's submit', 'q cancel') };
  }

  private startEditing(): Action {
    const row = this.focused();
    if (!row) return NONE;
    this.editor = createEditor(row.body);
    this.mode = 'edit';
    return NONE;
  }

  /** Saving an empty body is the same as unchecking the row: there is nothing left to post. */
  private commitEdit(text: string): void {
    const row = this.focused();
    if (row) {
      row.body = text;
      row.edited = text !== row.candidate.finding.comment;
      if (text.trim() === '') row.checked = false;
    }
  }

  private onEditKey(key: Key): Action {
    if (!this.editor) return NONE;
    const { state, result } = applyEditorKey(this.editor, key);
    this.editor = state;
    if (result === 'save') this.commitEdit(editorText(state));
    if (result) {
      this.editor = undefined;
      this.mode = 'list';
    }
    return NONE;
  }

  private onDetailKey(key: Key): Action {
    const nav = navIntent(key);
    if (nav) {
      if (nav.kind === 'first') this.detailOffset = 0;
      else if (nav.kind === 'last') this.detailOffset = Number.MAX_SAFE_INTEGER;
      else this.detailOffset = Math.max(0, this.detailOffset + nav.delta);
      return NONE;
    }
    if (key.name === 'char' && key.value === 'e') return this.startEditing();
    if (key.name === 'char' && key.value === ' ') {
      const row = this.focused();
      if (row) row.checked = !row.checked;
      return NONE;
    }
    this.mode = 'list';
    return NONE;
  }

  /** Ends the picker: `selected` for a submit, undefined for a cancel — the caller tells the two apart (see reviewMr.ts's ReviewRound). */
  private finish(selected: SelectableFinding[] | undefined): Action {
    this.done(selected);
    return { type: 'quit' };
  }

  // fallow-ignore-next-line complexity
  private onListKey(key: Key): Action {
    const nav = navIntent(key);
    if (nav) {
      this.index = applyNav(nav, this.index, this.visible().length);
      return NONE;
    }
    const row = this.focused();
    if (key.name === 'char' && key.value === ' ') {
      if (row) row.checked = !row.checked;
      return NONE;
    }
    if (key.name === 'enter' && row) {
      this.detailOffset = 0;
      this.mode = 'detail';
      return NONE;
    }
    if (key.name === 'char' && (key.value === 'a' || key.value === 'n')) {
      for (const each of this.visible()) each.checked = key.value === 'a' && each.body.trim() !== '';
      return NONE;
    }
    if (key.name === 'char' && key.value === 'e') return this.startEditing();
    if (key.name === 'char' && key.value === 'd') {
      this.showSeen = !this.showSeen;
      return NONE;
    }
    if (key.name === 'char' && key.value === 's') return this.finish(selectedFindings(this.rows));
    if (key.name === 'escape' || (key.name === 'char' && key.value === 'q') || (key.name === 'ctrl' && key.value === 'c')) return this.finish(undefined);
    return NONE;
  }

  onKey(key: Key): Action {
    if (this.mode === 'edit') return this.onEditKey(key);
    if (this.mode === 'detail') return this.onDetailKey(key);
    return this.onListKey(key);
  }
}
