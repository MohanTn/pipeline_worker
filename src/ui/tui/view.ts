/**
 * The contract between the TUI's app loop (app.ts) and its screens.
 *
 * A view is a small state machine: render() turns it into lines, onKey()
 * folds a keypress into either new internal state or an Action telling the app
 * to navigate. Views never touch the terminal themselves — that keeps every
 * screen testable by feeding it keys and inspecting the lines it returns.
 */

import type { Line } from './line.js';
import type { Size } from './screen.js';
import type { Key } from './keys.js';

/** What a view asks the app to do after handling a key. */
export type Action =
  | { type: 'none' }
  | { type: 'push'; view: View }
  | { type: 'pop' }
  | { type: 'quit' }
  /**
   * Hand the terminal back for a foreground job — a workflow run, a resume, a
   * review — which paints with the normal run dashboard while the TUI is off
   * the alt screen. The app restores the TUI afterwards.
   */
  | { type: 'suspend'; label: string; run: () => Promise<void> };

export const NONE: Action = { type: 'none' };

export interface RenderedView {
  /** The frame title, shown in the top border. */
  title: string;
  body: Line[];
  /** Key hints for the bottom border, e.g. '↑↓ move · ⏎ select · q back'. */
  hints: string;
}

export interface View {
  render(inner: Size): RenderedView;
  onKey(key: Key): Action | Promise<Action>;
}

/** True for the keys that mean "leave this screen" everywhere in the TUI. */
export function isBackKey(key: Key): boolean {
  return key.name === 'escape' || (key.name === 'char' && key.value === 'q') || (key.name === 'ctrl' && key.value === 'c');
}
