/**
 * The frame every TUI view is painted into: a titled box that fills the
 * terminal exactly, with the view's body inside and a key-hint strip along the
 * bottom border.
 *
 *   ┌ pipeline-worker · settings ────────────────────┐
 *   │  agent            claude              file     │
 *   │  forge            gitlab              default  │
 *   │                                                │
 *   └ ↑↓ move · ⏎ edit · ? help · q back ────────────┘
 *
 * frame() is pure (Size in, Line[] out) so a view's whole layout — including
 * how it degrades in an 20x8 terminal — is unit-testable with no terminal.
 */

import { fitLine, plainText, seg, type Line, type Segment } from './line.js';
import type { Size } from './screen.js';

/** Rows the frame itself consumes: the top and bottom borders. */
export const FRAME_CHROME_ROWS = 2;
/** Columns the frame itself consumes: '│ ' on the left, ' │' on the right. */
const FRAME_CHROME_COLUMNS = 4;

export interface FrameInput {
  title: string;
  body: Line[];
  hints: string;
}

export function innerSize(size: Size): Size {
  return {
    columns: Math.max(1, size.columns - FRAME_CHROME_COLUMNS),
    rows: Math.max(1, size.rows - FRAME_CHROME_ROWS),
  };
}

/**
 * A border row: '┌ label ───────┐', with the label dropped entirely when the
 * terminal is too narrow for it. The rule is painted in `surface2` and the
 * label in `mauve` so the frame recedes behind the content it holds — see
 * theme.ts on why the accent is not `sky`.
 */
function borderRow(left: string, right: string, label: string, width: number, labelRole: 'mauve' | 'subtext0'): Line {
  const decorated = label ? ` ${label} ` : '';
  const fill = width - 2 - decorated.length;
  if (fill < 0) {
    // Clip the label instead of dropping the corners. A hint strip that
    // outgrows the terminal used to render as a bare rule, which reads as a
    // broken frame — and the first hints on the strip are the common ones, so
    // keeping the head of it beats keeping none.
    const room = width - 4; // two corners and the spaces either side of the label
    if (room < 2) return fitLine([seg('─'.repeat(Math.max(0, width)), { role: 'surface2' })], width);
    return [
      seg(left, { role: 'surface2' }),
      seg(` ${label.slice(0, room - 1)}… `, { role: labelRole, bold: labelRole === 'mauve' }),
      seg(right, { role: 'surface2' }),
    ];
  }
  return [
    seg(left, { role: 'surface2' }),
    seg(decorated, { role: labelRole, bold: labelRole === 'mauve' }),
    seg('─'.repeat(fill), { role: 'surface2' }),
    seg(right, { role: 'surface2' }),
  ];
}

/**
 * The one selection affordance in the TUI: a full-height accent bar down both
 * edges of the focused row, with its content bolded. Every list-shaped screen
 * routes through this rather than drawing its own '❯', so the cursor looks and
 * measures the same everywhere.
 *
 * Both branches consume exactly two columns, so a row does not shift sideways
 * when it gains or loses focus — the misalignment a bare '❯ ' prefix causes.
 */
export function selectionRow(content: Line, width: number, selected: boolean): Line {
  const room = Math.max(0, width - 2);
  const inner = fitLine(selected ? content.map((part) => ({ ...part, bold: true })) : content, room);
  if (!selected) return [seg(' '), ...inner, seg(' ')];
  const bar = (text: string): Segment => seg(text, { role: 'mauve', bold: true });
  return [bar('▐'), ...inner, bar('▌')];
}

/**
 * Lays the view's body into the box, padding short bodies with blank rows and
 * clipping long ones — a view is responsible for windowing its own content
 * (see list.ts's viewportWindow), so clipping here is the last-resort guard,
 * not the scrolling mechanism.
 */
export function frame(input: FrameInput, size: Size): Line[] {
  const inner = innerSize(size);
  const rows: Line[] = [borderRow('┌', '┐', input.title, size.columns, 'mauve')];
  for (let i = 0; i < inner.rows; i++) {
    const line = input.body[i] ?? [];
    rows.push([seg('│ ', { role: 'surface2' }), ...fitLine(line, inner.columns), seg(' │', { role: 'surface2' })]);
  }
  rows.push(borderRow('└', '┘', input.hints, size.columns, 'subtext0'));
  return rows;
}

/** A section heading inside a view's body ('── GitLab ───────'): rule in chrome, label a step brighter so it stays scannable. */
export function sectionRow(label: string, width: number): Line {
  const head = `── ${label} `;
  return [seg('── ', { role: 'surface2' }), seg(label, { role: 'subtext0' }), seg(' ' + '─'.repeat(Math.max(0, width - head.length)), { role: 'surface2' })];
}

/**
 * A two-column row: label on the left, value right-aligned into `width`, with
 * the gap between them filled by the caller's spacing. The value is truncated
 * before the label so a long value can never push the label off the row.
 */
export function columnsRow(label: Line, value: Line, width: number): Line {
  const valueText = plainText(value);
  const labelRoom = Math.max(0, width - valueText.length - 1);
  const fittedLabel = fitLine(label, labelRoom);
  return [...fittedLabel, seg(' '), ...value];
}
