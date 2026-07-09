import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens } from '../src/ui/format.js';

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
