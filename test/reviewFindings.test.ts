import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatekeep, normalizeSuggestionFence, parseFindings } from '../src/review/findings.js';
import type { DiffChunk, ReviewFinding } from '../src/review/types.js';

const CHUNKS: DiffChunk[] = [
  { path: 'src/alpha.ts', language: 'TypeScript', body: '', commentableLines: [2, 3, 22] },
  { path: 'src/beta.ts', language: 'TypeScript', body: '', commentableLines: [7] },
];

function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return { file: 'src/alpha.ts', line: 2, severity: 'MAJOR', comment: 'boom', ...overrides };
}

test('parseFindings accepts the schema shape, a bare array, and JSON wrapped in prose', () => {
  assert.deepEqual(parseFindings('{"findings":[{"file":"a.ts","line":1,"severity":"MAJOR","comment":"x"}]}'), [
    { file: 'a.ts', line: 1, severity: 'MAJOR', comment: 'x' },
  ]);
  assert.equal(parseFindings('[{"file":"a.ts","line":1,"severity":"MINOR","comment":"x"}]').length, 1);
  assert.equal(parseFindings('Here you go:\n[{"file":"a.ts","line":1,"severity":"MINOR","comment":"x"}]\nHope that helps.').length, 1);
});

// An unusable answer must cost only its own chunk — never the whole review.
test('parseFindings returns [] for prose, truncated JSON, and off-schema payloads', () => {
  assert.deepEqual(parseFindings('The code looks fine to me.'), []);
  assert.deepEqual(parseFindings('{"findings":[{"file":"a.ts","line":1,'), []);
  assert.deepEqual(parseFindings('{"findings":[{"file":"a.ts","line":"nine","severity":"MAJOR","comment":"x"}]}'), []);
  assert.deepEqual(parseFindings('{"findings":[{"file":"a.ts","line":1,"severity":"NITPICK","comment":"x"}]}'), []);
});

test('gatekeep drops findings below the severity floor', () => {
  const kept = gatekeep([finding({ severity: 'MINOR' }), finding({ line: 3, severity: 'CRITICAL' })], CHUNKS, 'MAJOR', 10);
  assert.deepEqual(kept.map((f) => f.line), [3]);
});

test('gatekeep drops anchors that are not added lines in the diff (hallucinated or old-file numbers)', () => {
  const kept = gatekeep([finding({ line: 9999, severity: 'CRITICAL' }), finding({ file: 'src/unknown.ts', line: 2 })], CHUNKS, 'MAJOR', 10);
  assert.deepEqual(kept, []);
});

test('gatekeep dedupes on file+line and normalizes a/ b/ ./ path prefixes', () => {
  const kept = gatekeep([finding({ file: 'b/src/alpha.ts' }), finding({ file: './src/alpha.ts' }), finding({ file: 'src/alpha.ts' })], CHUNKS, 'MAJOR', 10);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].file, 'src/alpha.ts');
});

test('gatekeep sorts most severe first and caps the run at maxComments', () => {
  const kept = gatekeep(
    [finding({ line: 2, severity: 'MAJOR' }), finding({ file: 'src/beta.ts', line: 7, severity: 'CRITICAL' }), finding({ line: 22, severity: 'MAJOR' })],
    CHUNKS,
    'MAJOR',
    2,
  );
  assert.deepEqual(kept.map((f) => `${f.file}:${f.line}`), ['src/beta.ts:7', 'src/alpha.ts:2']);
});

test('normalizeSuggestionFence rewrites the fence to the active forge dialect, in both directions', () => {
  const github = 'Fix it:\n```suggestion\nconst x = 1;\n```\n';
  assert.match(normalizeSuggestionFence(github, 'gitlab'), /```suggestion:-0\+0\nconst x = 1;/);
  assert.match(normalizeSuggestionFence(github.replace('```suggestion', '```suggestion:-0+0'), 'github'), /```suggestion\nconst x = 1;/);
});

test('normalizeSuggestionFence leaves ordinary code fences alone', () => {
  const comment = 'Example:\n```ts\nconst x = 1;\n```\n';
  assert.equal(normalizeSuggestionFence(comment, 'gitlab'), comment);
});
