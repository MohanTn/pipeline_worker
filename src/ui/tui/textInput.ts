/**
 * A single-line text field: immutable state plus one reducer over parsed keys,
 * so editing behaviour (cursor motion, backspace at the start, insertion
 * mid-string) is unit-testable without a terminal.
 *
 * The caller decides what enter/escape mean — the reducer ignores both, and
 * reports whether it consumed the key so a view can fall through to its own
 * bindings for the ones it did not.
 */

import { seg, type Line } from './line.js';
import type { Key } from './keys.js';

export interface InputState {
  value: string;
  /** Insertion point, 0..value.length. */
  cursor: number;
}

export function createInput(value = ''): InputState {
  return { value, cursor: value.length };
}

export interface InputResult {
  state: InputState;
  /** False when the key means nothing to a text field, so the view can handle it. */
  handled: boolean;
}

// fallow-ignore-next-line complexity
export function applyKey(state: InputState, key: Key): InputResult {
  const { value, cursor } = state;
  switch (key.name) {
    case 'char':
      return { state: { value: value.slice(0, cursor) + key.value + value.slice(cursor), cursor: cursor + 1 }, handled: true };
    case 'backspace':
      if (cursor === 0) return { state, handled: true };
      return { state: { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 }, handled: true };
    case 'delete':
      return { state: { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor }, handled: true };
    case 'left':
      return { state: { value, cursor: Math.max(0, cursor - 1) }, handled: true };
    case 'right':
      return { state: { value, cursor: Math.min(value.length, cursor + 1) }, handled: true };
    case 'home':
      return { state: { value, cursor: 0 }, handled: true };
    case 'end':
      return { state: { value, cursor: value.length }, handled: true };
    case 'ctrl':
      // ctrl-u clears the field, the readline habit most people already have.
      if (key.value === 'u') return { state: createInput(''), handled: true };
      return { state, handled: false };
    default:
      return { state, handled: false };
  }
}

/**
 * Paints the field with the character under the cursor inverted — the TUI
 * hides the real terminal cursor (screen.ts), so the caret has to be drawn.
 * A trailing space stands in for the caret when the cursor sits past the end.
 */
export function renderInput(state: InputState, placeholder = ''): Line {
  if (state.value === '' && placeholder) {
    return [seg(' ', { invert: true }), seg(placeholder, { role: 'overlay1' })];
  }
  const before = state.value.slice(0, state.cursor);
  const at = state.value.slice(state.cursor, state.cursor + 1) || ' ';
  const after = state.value.slice(state.cursor + 1);
  return [seg(before), seg(at, { invert: true }), seg(after)];
}
