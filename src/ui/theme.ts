/**
 * Catppuccin Mocha palette for pipeline-worker's terminal output. node:util's
 * styleText only reaches the basic 16 ANSI color names, which can't produce
 * Catppuccin's exact hex values, so semantic color roles are painted here
 * with 24-bit ("truecolor") escape codes instead. Enablement mirrors the
 * signals styleText itself honors (NO_COLOR, FORCE_COLOR, TTY-ness) so
 * piped/CI output and `plainOutput` stay plain — see renderer.ts's
 * non-color-stream contract.
 *
 * https://github.com/catppuccin/catppuccin#-mocha
 */

const PALETTE = {
  green: '#a6e3a1', // done / success / low risk
  red: '#f38ba8', // failed / error / high risk
  yellow: '#f9e2af', // watch phase / medium risk
  sky: '#89dceb', // running / in-progress / checks / mr phase
  overlay1: '#7f849c', // muted/secondary text (replaces plain ANSI "dim")
} as const;

export type MochaRole = keyof typeof PALETTE;

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mirrors node:util styleText's own enable/disable signals so piped/CI output stays plain. */
function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

/** Paints `text` in a Catppuccin Mocha role color, or returns it unchanged when color is disabled. */
export function mocha(role: MochaRole, text: string): string {
  if (!colorsEnabled()) return text;
  const [r, g, b] = hexToRgb(PALETTE[role]);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
