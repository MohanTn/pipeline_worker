/** Shared human-readable formatting helpers for token/duration figures. */

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
