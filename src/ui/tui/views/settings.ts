/**
 * The settings editor: every key in the settings file, grouped, with the value
 * in force, where that value came from (file / auto-detected / default), and —
 * on '?' — the paragraph from configSchema.ts explaining what it does.
 *
 * Edits are written straight through to the file and the config re-resolved,
 * so the "source" column and any auto-detected value stay honest after every
 * change; there is no dirty state to lose. Clearing a field (d) removes the
 * key rather than writing its default, which hands the value back to
 * auto-detection.
 *
 * All file access goes through an injected SettingsIo, so the whole screen is
 * testable without a real HOME or config file.
 */

import { seg, wrap, type Line } from '../line.js';
import { clampIndex, firstSelectable, moveToSelectable, viewportWindow } from '../list.js';
import { sectionRow } from '../chrome.js';
import { applyKey, createInput, renderInput, type InputState } from '../textInput.js';
import { setAtPath, unsetAtPath } from '../configStore.js';
import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  cycleValue,
  displayValue,
  effectiveValue,
  parseFieldInput,
  valueSource,
  type ConfigField,
} from '../configSchema.js';
import { NONE, isBackKey, type Action, type RenderedView, type View } from '../view.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';
import type { PipelineWorkerConfig } from '../../../types.js';

/** The settings file, abstracted so tests drive the editor against an in-memory object. */
export interface SettingsIo {
  read(): Record<string, unknown>;
  save(settings: Record<string, unknown>): { ok: true } | { ok: false; error: string };
  /** The config as the workflow would resolve it right now — the source of auto-detected values. */
  resolve(): PipelineWorkerConfig;
}

type Row = { kind: 'group'; label: string } | { kind: 'field'; field: ConfigField };

/** Group headings interleaved with their fields, in CONFIG_GROUPS order — the list the cursor walks. */
export function buildRows(fields: readonly ConfigField[] = CONFIG_FIELDS): Row[] {
  const rows: Row[] = [];
  for (const group of CONFIG_GROUPS) {
    const members = fields.filter((field) => field.group === group);
    if (members.length === 0) continue;
    rows.push({ kind: 'group', label: group });
    for (const field of members) rows.push({ kind: 'field', field });
  }
  return rows;
}

const SOURCE_ROLE = { file: 'green', auto: 'sky', default: 'overlay1' } as const;
const HELP_ROWS = 5;
const VALUE_COLUMN = 26;

export class SettingsView implements View {
  private readonly rows = buildRows();
  private index: number;
  private windowStart = 0;
  private settings: Record<string, unknown>;
  private config: PipelineWorkerConfig;
  private editing: { field: ConfigField; input: InputState; error?: string } | undefined;
  private showHelp = true;
  private status: { text: string; ok: boolean } | undefined;

  constructor(private readonly io: SettingsIo) {
    this.settings = io.read();
    this.config = io.resolve();
    this.index = firstSelectable(this.rows.length, (i) => this.rows[i].kind === 'field');
  }

  private selectable(i: number): boolean {
    return this.rows[i]?.kind === 'field';
  }

  private focusedField(): ConfigField | undefined {
    const row = this.rows[clampIndex(this.index, this.rows.length)];
    return row?.kind === 'field' ? row.field : undefined;
  }

  /** Writes the edited settings object through and re-resolves, so the view immediately shows what the next run would see. */
  private commit(next: Record<string, unknown>): void {
    const result = this.io.save(next);
    if (!result.ok) {
      this.status = { text: `could not save: ${result.error}`, ok: false };
      return;
    }
    this.settings = next;
    this.config = this.io.resolve();
    this.status = { text: 'saved', ok: true };
  }

  private fieldRow(field: ConfigField, selected: boolean, width: number): Line {
    const source = valueSource(field, this.settings, this.config);
    const value = displayValue(field, effectiveValue(field, this.config));
    const label = `  ${field.label}`.padEnd(VALUE_COLUMN);
    const valueRole = source === 'default' ? 'overlay1' : undefined;
    const line: Line = [
      seg(selected ? '❯' : ' ', { role: 'sky', bold: true }),
      seg(label, { bold: selected }),
      seg(value, { role: valueRole, bold: selected }),
    ];
    // The source tag is right-aligned into whatever room is left, and dropped
    // entirely on a terminal too narrow to hold it without eating the value.
    const used = 1 + label.length + value.length;
    const gap = width - used - source.length;
    if (gap < 1) return line;
    return [...line, seg(' '.repeat(gap)), seg(source, { role: SOURCE_ROLE[source] })];
  }

  private helpPanel(width: number): Line[] {
    const field = this.focusedField();
    if (!field) return [];
    const lines: Line[] = [sectionRow(field.path, width)];
    const doc = field.choices ? `${field.doc} Choices: ${field.choices.join(' / ')}.` : field.doc;
    for (const text of wrap(doc, width).slice(0, HELP_ROWS - 1)) lines.push([seg(text, { role: 'overlay1' })]);
    return lines;
  }

  /** The bottom strip: the open edit line (with any validation error) or the last save's outcome. Truncation is the frame's job (chrome.ts fits every body line). */
  private footerRows(): Line[] {
    if (this.editing) {
      const { field, input, error } = this.editing;
      const rows: Line[] = [[seg(`  ${field.path} = `, { role: 'sky' }), ...renderInput(input, field.placeholder ?? '')]];
      if (error) rows.push([seg(`  ${error}`, { role: 'red' })]);
      return rows;
    }
    if (this.status) return [[seg(`  ${this.status.text}`, { role: this.status.ok ? 'green' : 'red' })]];
    return [];
  }

  render(inner: Size): RenderedView {
    const help = this.showHelp ? this.helpPanel(inner.columns) : [];
    const footer = this.footerRows();
    const listRows = Math.max(1, inner.rows - help.length - footer.length - (help.length > 0 ? 1 : 0));
    const { start, end } = viewportWindow(this.index, this.rows.length, listRows, this.windowStart);
    this.windowStart = start;

    const body: Line[] = [];
    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      body.push(row.kind === 'group' ? sectionRow(row.label, inner.columns) : this.fieldRow(row.field, i === this.index, inner.columns));
    }
    if (help.length > 0) body.push([]);
    body.push(...help, ...footer);

    return {
      title: 'settings',
      hints: this.editing ? '⏎ save · esc cancel · ctrl-u clear' : '↑↓ move · ⏎ edit/toggle · d default · ? help · q back',
      body,
    };
  }

  private startEditing(field: ConfigField): void {
    const current = effectiveValue(field, this.config);
    // Secrets open empty rather than pre-filled: the stored value is masked in
    // the row, so pre-filling it would leak the token into the edit line.
    const initial = field.kind === 'secret' ? '' : current === undefined || current === null ? '' : String(current);
    this.editing = { field, input: createInput(initial) };
    this.status = undefined;
  }

  private commitEdit(): void {
    if (!this.editing) return;
    const { field, input } = this.editing;
    const parsed = parseFieldInput(field, input.value);
    if (!parsed.ok) {
      this.editing = { ...this.editing, error: parsed.error };
      return;
    }
    this.editing = undefined;
    this.commit(setAtPath(this.settings, field.path, parsed.value));
  }

  // fallow-ignore-next-line complexity
  private onEditKey(key: Key): Action {
    if (key.name === 'enter') {
      this.commitEdit();
      return NONE;
    }
    if (key.name === 'escape') {
      this.editing = undefined;
      return NONE;
    }
    const result = applyKey(this.editing!.input, key);
    if (result.handled) this.editing = { field: this.editing!.field, input: result.state };
    return NONE;
  }

  private activateFocused(): void {
    const field = this.focusedField();
    if (!field) return;
    const cycled = cycleValue(field, effectiveValue(field, this.config));
    if (cycled === undefined) this.startEditing(field);
    else this.commit(setAtPath(this.settings, field.path, cycled));
  }

  // fallow-ignore-next-line complexity
  onKey(key: Key): Action {
    if (this.editing) return this.onEditKey(key);
    if (isBackKey(key)) return { type: 'pop' };
    if (key.name === 'up') this.index = moveToSelectable(this.index, -1, this.rows.length, (i) => this.selectable(i));
    else if (key.name === 'down') this.index = moveToSelectable(this.index, 1, this.rows.length, (i) => this.selectable(i));
    else if (key.name === 'enter') this.activateFocused();
    else if (key.name === 'char' && key.value === '?') this.showHelp = !this.showHelp;
    else if (key.name === 'char' && key.value === 'd') {
      const field = this.focusedField();
      if (field) this.commit(unsetAtPath(this.settings, field.path));
    }
    return NONE;
  }
}
