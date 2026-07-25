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

import { fitLine, plainText, seg, type Line } from './line.js';
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

/** A border row: '┌ label ───────┐', with the label dropped entirely when the terminal is too narrow for it. */
function borderRow(left: string, right: string, label: string, width: number): Line {
  const decorated = label ? ` ${label} ` : '';
  const fill = width - 2 - decorated.length;
  if (fill < 0) return fitLine([seg('─'.repeat(Math.max(0, width)), { role: 'overlay1' })], width);
  return [
    seg(left, { role: 'overlay1' }),
    seg(decorated, { role: 'sky', bold: true }),
    seg('─'.repeat(fill), { role: 'overlay1' }),
    seg(right, { role: 'overlay1' }),
  ];
}

/**
 * Lays the view's body into the box, padding short bodies with blank rows and
 * clipping long ones — a view is responsible for windowing its own content
 * (see list.ts's viewportWindow), so clipping here is the last-resort guard,
 * not the scrolling mechanism.
 */
export function frame(input: FrameInput, size: Size): Line[] {
  const inner = innerSize(size);
  const rows: Line[] = [borderRow('┌', '┐', input.title, size.columns)];
  for (let i = 0; i < inner.rows; i++) {
    const line = input.body[i] ?? [];
    rows.push([seg('│ ', { role: 'overlay1' }), ...fitLine(line, inner.columns), seg(' │', { role: 'overlay1' })]);
  }
  rows.push(borderRow('└', '┘', input.hints, size.columns));
  return rows;
}

/** A dimmed section heading inside a view's body ('── GitLab ───────'). */
export function sectionRow(label: string, width: number): Line {
  const head = `── ${label} `;
  return [seg(head + '─'.repeat(Math.max(0, width - head.length)), { role: 'overlay1' })];
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
