import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@toon-format/toon';
import { buildEnvelope, errorEnvelope } from '../src/toon/envelope.js';

test('buildEnvelope includes status, chars, and body between --- markers', () => {
  const text = buildEnvelope({ status: 'success', data: { id: 1, name: 'lint' } });
  assert.match(text, /^status: success\n/);
  assert.match(text, /chars: \d+/);
  const body = text.split('---')[1].trim();
  assert.deepEqual(decode(body), { id: 1, name: 'lint' });
});

test('buildEnvelope adds counts before the body', () => {
  const text = buildEnvelope({ status: 'success', data: [1, 2, 3], counts: { total: 3 } });
  assert.match(text, /status: success\ntotal: 3\nchars:/);
});

test('buildEnvelope appends next: hint when provided and not truncated', () => {
  const text = buildEnvelope({ status: 'success', data: { a: 1 }, next: 'call foo' });
  assert.match(text, /next: call foo$/);
});

test('buildEnvelope truncates long bodies and offers the full=true escape hatch', () => {
  const bigArray = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}` }));
  const truncated = buildEnvelope({ status: 'success', data: bigArray }, { maxChars: 200 });
  assert.match(truncated, /note: truncated to 200 of \d+ chars/);
  assert.match(truncated, /next: call again with full=true to see the rest/);

  const full = buildEnvelope({ status: 'success', data: bigArray }, { maxChars: 200, full: true });
  assert.doesNotMatch(full, /note: truncated/);
});

test('errorEnvelope produces a status/kind/message shape', () => {
  const text = errorEnvelope('gitlab_error', 'boom');
  assert.equal(text, 'status: error\nkind: gitlab_error\nmessage: boom');
});
