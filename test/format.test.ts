import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCount, formatTokens, formatUsageInline, freshInputTokens, usageFooter } from '../src/ui/format.js';

test('formatTokens renders sub-thousand counts as plain integers', () => {
  assert.equal(formatTokens(0), '0 tok');
  assert.equal(formatTokens(949), '949 tok');
  assert.equal(formatTokens(949.6), '950 tok');
});

test('formatTokens renders thousands with one decimal, trimming a trailing .0', () => {
  assert.equal(formatTokens(1900), '1.9k tok');
  assert.equal(formatTokens(41_200), '41.2k tok');
  assert.equal(formatTokens(2000), '2k tok');
});

test('formatTokens renders millions', () => {
  assert.equal(formatTokens(1_200_000), '1.2M tok');
  assert.equal(formatTokens(3_000_000), '3M tok');
});

test('formatTokens degrades non-finite or negative input to a placeholder instead of nonsense', () => {
  assert.equal(formatTokens(Number.NaN), '? tok');
  assert.equal(formatTokens(-5), '? tok');
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), '? tok');
});

test('formatCount drops the unit for figures whose label already names them', () => {
  assert.equal(formatCount(949), '949');
  assert.equal(formatCount(98_500), '98.5k');
  assert.equal(formatCount(Number.NaN), '?');
});

test('freshInputTokens subtracts both cache shares from the folded prompt total', () => {
  assert.equal(freshInputTokens({ inputTokens: 101_700, cacheReadTokens: 92_000, cacheWriteTokens: 4000 }), 5700);
  assert.equal(freshInputTokens({ inputTokens: 6500 }), 6500);
});

test('freshInputTokens reports unknown when the prompt side was never reported, and never goes negative', () => {
  assert.equal(freshInputTokens({ outputTokens: 250 }), undefined);
  assert.equal(freshInputTokens({ inputTokens: 100, cacheReadTokens: 900 }), 0);
});

test('formatUsageInline leads with prompt tokens and calls out the cache-read share', () => {
  assert.equal(formatUsageInline({ inputTokens: 98_500, cacheReadTokens: 92_000, outputTokens: 3200 }), 'in 98.5k (92k cached) · out 3.2k');
});

test('formatUsageInline omits the cache note when nothing was reused, and omits a side that is unknown', () => {
  assert.equal(formatUsageInline({ inputTokens: 6500, outputTokens: 400 }), 'in 6.5k · out 400');
  assert.equal(formatUsageInline({ inputTokens: 6500, cacheReadTokens: 0 }), 'in 6.5k');
  assert.equal(formatUsageInline({ outputTokens: 250 }), 'out 250');
});

test('formatUsageInline returns empty for a split with neither side, so callers fall back to the total', () => {
  assert.equal(formatUsageInline({}), '');
  assert.equal(formatUsageInline({ cacheReadTokens: 900 }), '');
});

test('usageFooter breaks each row into fresh input, both cache shares, and output, with a total row', () => {
  const lines = usageFooter([{ label: 'intent', usage: { inputTokens: 101_700, cacheReadTokens: 92_000, cacheWriteTokens: 4000, outputTokens: 3200 } }], 104_900);
  assert.match(lines[0], /token usage/);
  assert.match(lines[1], /intent {2}in 5\.7k · cache-read 92k · cache-write 4k · out 3\.2k/);
  assert.match(lines[2], /total {3}104\.9k tok/);
});

test('usageFooter omits cache segments a turn never reported and pads labels to a common width', () => {
  const lines = usageFooter(
    [
      { label: 'intent', usage: { inputTokens: 6500, outputTokens: 400 } },
      { label: 'ci-fix', usage: { inputTokens: 2000, cacheReadTokens: 1500 } },
    ],
    8900,
  );
  assert.equal(lines[1], '  intent  in 6.5k · out 400');
  assert.equal(lines[2], '  ci-fix  in 500 · cache-read 1.5k');
});

test('usageFooter is empty when no step reported a split — nothing to break down', () => {
  assert.deepEqual(usageFooter([], 4400), []);
});
