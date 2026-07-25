/**
 * The run launcher: the two optional flags `pipeline-worker run` takes
 * (--ticket, --target), then a button that hands the terminal over.
 *
 * The run itself is deliberately NOT painted inside the TUI. Suspending to the
 * normal screen means the existing live tree dashboard (ui/steps.ts,
 * ui/treeRenderer.ts) drives the run exactly as it does from the plain CLI —
 * one renderer to maintain, one output format to reason about, and the run's
 * narration is left in scrollback afterwards instead of vanishing with the alt
 * screen.
 */

import { seg, wrap, type Line } from '../line.js';
import { moveIndex } from '../list.js';
import { sectionRow } from '../chrome.js';
import { applyKey, createInput, renderInput, type InputState } from '../textInput.js';
import { NONE, isBackKey, type Action, type RenderedView, type View } from '../view.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';

export interface RunIo {
  start(options: { ticket?: string; target?: string }): Promise<void>;
}

interface FieldSpec {
  key: 'ticket' | 'target';
  label: string;
  placeholder: string;
  help: string;
}

const FIELDS: readonly FieldSpec[] = [
  {
    key: 'ticket',
    label: 'ticket',
    placeholder: '(none)',
    help: 'Interpolated into the {ticket} placeholder of your branchPattern. Leave it empty if your pattern has none.',
  },
  {
    key: 'target',
    label: 'target branch',
    placeholder: "(origin's default branch)",
    help: "Base branch for the merge request. Empty means origin's default branch — main or master.",
  },
];

/** Rows: one per field, then the start button. */
const START_ROW = FIELDS.length;

export class RunView implements View {
  private readonly inputs: Record<string, InputState> = { ticket: createInput(''), target: createInput('') };
  private index = 0;

  constructor(private readonly io: RunIo) {}

  private options(): { ticket?: string; target?: string } {
    const ticket = this.inputs.ticket.value.trim();
    const target = this.inputs.target.value.trim();
    return { ticket: ticket || undefined, target: target || undefined };
  }

  render(inner: Size): RenderedView {
    const body: Line[] = [
      [seg('Capture your current diff and drive it to a green merge request.', { role: 'overlay1' })],
      [],
    ];
    FIELDS.forEach((spec, i) => {
      const selected = i === this.index;
      body.push([
        seg(selected ? ' ❯ ' : '   ', { role: 'sky', bold: true }),
        seg(spec.label.padEnd(15), { bold: selected }),
        ...renderInput(this.inputs[spec.key], spec.placeholder),
      ]);
    });
    body.push([]);
    const startSelected = this.index === START_ROW;
    body.push([
      seg(startSelected ? ' ❯ ' : '   ', { role: 'sky', bold: true }),
      seg(' Start run ', { invert: startSelected, bold: true, role: startSelected ? undefined : 'overlay1' }),
    ]);

    const help = FIELDS[this.index]?.help ?? 'Hands the terminal to the run dashboard until the run settles, then comes back here.';
    body.push([], sectionRow('about this field', inner.columns));
    for (const text of wrap(help, inner.columns)) body.push([seg(text, { role: 'overlay1' })]);

    return { title: 'run', body, hints: '↑↓ move · ⏎ start · esc back' };
  }

  // fallow-ignore-next-line complexity
  onKey(key: Key): Action {
    if (key.name === 'escape' || (key.name === 'ctrl' && key.value === 'c')) return { type: 'pop' };
    if (key.name === 'up') {
      this.index = moveIndex(this.index, -1, FIELDS.length + 1);
      return NONE;
    }
    if (key.name === 'down' || key.name === 'tab') {
      this.index = moveIndex(this.index, 1, FIELDS.length + 1);
      return NONE;
    }
    if (this.index === START_ROW) {
      if (key.name === 'enter') {
        const options = this.options();
        return { type: 'suspend', label: 'run', run: () => this.io.start(options) };
      }
      // A ticket id is a plausible thing to type while the button is focused,
      // so 'q' here means quit only because no field has focus to receive it.
      return isBackKey(key) ? { type: 'pop' } : NONE;
    }
    if (key.name === 'enter') {
      this.index = START_ROW;
      return NONE;
    }
    const spec = FIELDS[this.index];
    const result = applyKey(this.inputs[spec.key], key);
    if (result.handled) this.inputs[spec.key] = result.state;
    return NONE;
  }
}
