/**
 * The TUI's unit of output: a line as a list of styled segments, never as a
 * pre-colored string.
 *
 * ANSI escapes are zero-width, so any width math done on an already-colored
 * string is wrong — the same trap treeRenderer.ts documents. Keeping text and
 * style apart until the last moment lets fitLine() truncate and pad on the
 * plain characters, and renderLine() paint afterwards, so a frame's borders
 * line up at every terminal width.
 */

import { styleText } from 'node:util';
import { mocha, type MochaRole } from '../theme.js';

export interface Segment {
  text: string;
  role?: MochaRole;
  bold?: boolean;
  /** Reverse video — how the TUI marks the selected row (works on every theme). */
  invert?: boolean;
}

export type Line = Segment[];

export function seg(text: string, style: Omit<Segment, 'text'> = {}): Segment {
  return { text, ...style };
}

/** The visible characters of a line, with no escape codes — what all width math runs on. */
export function plainText(line: Line): string {
  return line.map((part) => part.text).join('');
}

function paint(part: Segment): string {
  let out = part.role ? mocha(part.role, part.text) : part.text;
  // styleText disables itself on non-color streams, matching theme.ts's
  // mocha(), so a piped or NO_COLOR terminal gets plain text from both.
  if (part.bold) out = styleText('bold', out);
  if (part.invert) out = styleText('inverse', out);
  return out;
}

/**
 * Truncates or space-pads a line to exactly `width` visible characters, so
 * callers can drop it into a fixed-width slot (a box's interior, a column)
 * without measuring. Truncation keeps a trailing '…' as the overflow marker,
 * matching the run dashboard's truncateToWidth.
 */
export function fitLine(line: Line, width: number): Line {
  if (width <= 0) return [];
  const length = plainText(line).length;
  if (length === width) return line;
  if (length < width) return [...line, seg(' '.repeat(width - length))];

  const budget = width - 1;
  const fitted: Line = [];
  let used = 0;
  for (const part of line) {
    if (used >= budget) break;
    const take = Math.min(part.text.length, budget - used);
    fitted.push({ ...part, text: part.text.slice(0, take) });
    used += take;
  }
  fitted.push(seg('…'));
  return fitted;
}

/** Paints a line, truncating first when it would overflow `width` (a no-op on an already-fitted line). */
export function renderLine(line: Line, width: number): string {
  return fitLine(line, width)
    .filter((part) => part.text.length > 0)
    .map(paint)
    .join('');
}

/** Wraps plain text to `width`, breaking on spaces and hard-splitting any word longer than the line. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (current === '') current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
      while (current.length > width) {
        lines.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    lines.push(current);
  }
  return lines;
}
