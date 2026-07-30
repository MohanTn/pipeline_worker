/** Shared human-readable formatting helpers for token/duration figures and output structure. */

import { styleText } from 'node:util';
import type { TokenSplit } from './runTree.js';

/**
 * A token count without the unit — for figures whose own label already says
 * what they are (`in 98.5k`, `cache-read 92k`). Scales at 1000 with one decimal
 * place, trailing `.0` trimmed, and renders an unusable number as `?`.
 */
export function formatCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '?';
  if (tokens < 1000) return `${Math.round(tokens)}`;
  const scaled = tokens < 1_000_000 ? { value: tokens / 1000, suffix: 'k' } : { value: tokens / 1_000_000, suffix: 'M' };
  return `${scaled.value.toFixed(1).replace(/\.0$/, '')}${scaled.suffix}`;
}

/**
 * Renders a token count the way the run header and session views show it:
 * `949 tok`, `1.9k tok`, `41.2k tok`, `1.2M tok`. One decimal place above
 * 1000, with a trailing `.0` trimmed so round figures read as `2k tok`, not
 * `2.0k tok`.
 */
export function formatTokens(tokens: number): string {
  return `${formatCount(tokens)} tok`;
}

const RELATIVE_UNITS: readonly (readonly [limit: number, seconds: number, suffix: string])[] = [
  [60, 1, 's'],
  [3600, 60, 'm'],
  [86_400, 3600, 'h'],
  [604_800, 86_400, 'd'],
  [31_536_000, 604_800, 'w'],
];

/**
 * An age, not a date: `4m ago`, `2h ago`, `13d ago`. Session rows are scanned
 * for "which run is the one I just left", a question an absolute timestamp
 * makes the reader answer by subtraction — and `toLocaleString()` spends
 * ~22 locale-dependent columns doing it, enough to push a branch name off an
 * 80-column terminal. Caps at 7 characters (`52w ago`).
 */
export function formatRelative(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((now - then) / 1000);
  // A state file written by a machine with a fast clock reads as the future;
  // that is not worth a special vocabulary, so it collapses to the present.
  if (seconds < 1) return 'now';
  for (const [limit, divisor, suffix] of RELATIVE_UNITS) {
    if (seconds < limit) return `${Math.floor(seconds / divisor)}${suffix} ago`;
  }
  return `${Math.floor(seconds / 31_536_000)}y ago`;
}

/**
 * The prompt tokens a turn actually processed fresh: inputTokens minus the
 * cache-read and cache-write shares folded into it. Undefined when the
 * prompt side wasn't reported at all; clamped at 0 so a reshaped envelope whose
 * parts exceed the total can't print a negative figure.
 */
export function freshInputTokens(usage: TokenSplit): number | undefined {
  if (usage.inputTokens === undefined) return undefined;
  return Math.max(0, usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0));
}

/**
 * The step-row form: `in 98.5k (92k cached) · out 3.2k`. Prompt-side tokens
 * lead, with the cache-read share called out, because that share is what makes
 * a modest turn look enormous — an agent loop re-sends its whole prompt on
 * every internal turn and every re-send is counted again, at a fraction of
 * fresh input's price. '' when the split reports neither side, which tells
 * callers to fall back to the plain total.
 */
export function formatUsageInline(usage: TokenSplit): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    const cached = usage.cacheReadTokens;
    const cachedPart = cached !== undefined && cached > 0 ? ` (${formatCount(cached)} cached)` : '';
    parts.push(`in ${formatCount(usage.inputTokens)}${cachedPart}`);
  }
  if (usage.outputTokens !== undefined) parts.push(`out ${formatCount(usage.outputTokens)}`);
  return parts.join(' · ');
}

const FOOTER_WIDTH = 60;
const TOTAL_LABEL = 'total';

/** One step's row in the footer table: every figure the CLI reports separately, zero/unknown parts omitted. */
function usageRowFigures(usage: TokenSplit): string {
  const parts: string[] = [];
  const fresh = freshInputTokens(usage);
  if (fresh !== undefined) parts.push(`in ${formatCount(fresh)}`);
  if (usage.cacheReadTokens) parts.push(`cache-read ${formatCount(usage.cacheReadTokens)}`);
  if (usage.cacheWriteTokens) parts.push(`cache-write ${formatCount(usage.cacheWriteTokens)}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${formatCount(usage.outputTokens)}`);
  return parts.join(' · ');
}

/**
 * The settled run's per-turn token table, unstyled (renderers dim it): one row
 * per step that ran an agent turn, then the run total. It exists because the
 * total on its own is misleading — cache reads are summed into it at full
 * weight, so this splits out what was processed fresh, what was reused from
 * cache, and what the model actually wrote. Empty when no step reported a
 * split, since there is then nothing to break down.
 */
export function usageFooter(rows: Array<{ label: string; usage: TokenSplit }>, total: number): string[] {
  if (rows.length === 0) return [];
  const labelWidth = Math.max(TOTAL_LABEL.length, ...rows.map((row) => row.label.length));
  const head = '── token usage ';
  const lines = [head + '─'.repeat(Math.max(0, FOOTER_WIDTH - head.length))];
  for (const row of rows) lines.push(`  ${row.label.padEnd(labelWidth)}  ${usageRowFigures(row.usage)}`);
  lines.push(`  ${TOTAL_LABEL.padEnd(labelWidth)}  ${formatTokens(total)}`);
  return lines;
}

const BOX_WIDTH = 100;

function boxLine(content = '', width = BOX_WIDTH): string {
  if (!content) return `│${' '.repeat(width - 2)}│`;
  const padding = Math.max(0, width - content.length - 2);
  return `│ ${content}${' '.repeat(padding)} │`;
}

export function boxTop(): string {
  return `┌${`─`.repeat(BOX_WIDTH - 2)}┐`;
}

export function boxBottom(): string {
  return `└${`─`.repeat(BOX_WIDTH - 2)}┘`;
}

export function boxHeader(text: string, emoji = ''): string[] {
  const title = emoji ? `${emoji} ${text}` : text;
  return [
    boxTop(),
    boxLine(styleText('bold', title)),
    boxBottom(),
  ];
}

export function boxBullet(label: string, value: string, indent = 0): string {
  const prefix = '• ';
  const indentStr = ' '.repeat(indent);
  const labelStr = label ? `${label.padEnd(12)}` : '';
  return `${indentStr}${prefix}${labelStr}${value}`;
}

export function wrapText(text: string, maxWidth = BOX_WIDTH - 6, indent = 2): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/);
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length > maxWidth ? word : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.map((line) => `${' '.repeat(indent)}${line}`);
}

/** Formats a multi-line block with wrapping for long text values. */
export function formatBulletBlock(
  items: Array<{ label: string; value: string; wrap?: boolean }>,
  indent = 2,
): string[] {
  const lines: string[] = [];
  const maxLabelWidth = Math.max(...items.map((item) => item.label.length));

  for (const item of items) {
    const prefix = '• ';
    const indentStr = ' '.repeat(indent);
    const labelPad = item.label.padEnd(maxLabelWidth);

    if (item.wrap && item.value.length > BOX_WIDTH - indent - prefix.length - maxLabelWidth - 5) {
      // First line with label
      lines.push(`${indentStr}${prefix}${labelPad}  ${item.value.split('\n')[0]}`);
      // Continuation lines
      const continuationIndent = ' '.repeat(indent + prefix.length + maxLabelWidth + 2);
      const wrapped = wrapText(item.value.substring(item.value.split('\n')[0].length), BOX_WIDTH - indent - 6, 0);
      for (const line of wrapped) {
        if (line.trim()) lines.push(`${continuationIndent}${line}`);
      }
    } else {
      lines.push(`${indentStr}${prefix}${labelPad}  ${item.value}`);
    }
  }

  return lines;
}
