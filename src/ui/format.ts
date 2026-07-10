/** Shared human-readable formatting helpers for token/duration figures and output structure. */

import { styleText } from 'node:util';

/**
 * Renders a token count the way the run header and session views show it:
 * `949 tok`, `1.9k tok`, `41.2k tok`, `1.2M tok`. One decimal place above
 * 1000, with a trailing `.0` trimmed so round figures read as `2k tok`, not
 * `2.0k tok`.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '? tok';
  if (tokens < 1000) return `${Math.round(tokens)} tok`;
  const scaled = tokens < 1_000_000 ? { value: tokens / 1000, suffix: 'k' } : { value: tokens / 1_000_000, suffix: 'M' };
  const text = scaled.value.toFixed(1).replace(/\.0$/, '');
  return `${text}${scaled.suffix} tok`;
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
