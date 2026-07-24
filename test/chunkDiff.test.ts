import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDiff, detectLanguage } from '../src/review/chunkDiff.js';

/**
 * Three files in one patch: a TypeScript file with two hunks (the case that
 * breaks naive line counting), a deleted file, and a binary file. The last
 * two carry nothing a comment could anchor to.
 */
const PATCH_3_FILES = [
  'diff --git a/src/alpha.ts b/src/alpha.ts',
  'index 1111111..2222222 100644',
  '--- a/src/alpha.ts',
  '+++ b/src/alpha.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  ' const e = 6;',
  '@@ -20,3 +21,4 @@ function tail() {',
  ' line20',
  '+added21',
  ' line21',
  ' line22',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-old1',
  '-old2',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 4444444..5555555 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/scripts/run.py b/scripts/run.py',
  'new file mode 100644',
  'index 0000000..6666666',
  '--- /dev/null',
  '+++ b/scripts/run.py',
  '@@ -0,0 +1,2 @@',
  '+import os',
  '+print(os.getcwd())',
  '',
].join('\n');

test('detectLanguage names the language from the extension and falls back to text', () => {
  assert.equal(detectLanguage('src/alpha.ts'), 'TypeScript');
  assert.equal(detectLanguage('scripts/run.py'), 'Python');
  assert.equal(detectLanguage('Makefile'), 'text');
});

// The whole feature hangs off this number: a comment anchored to the wrong
// line lands on unrelated code, or is rejected outright by the forge.
test('numbers new-file lines across multiple hunks, counting added and context lines but not removed ones', () => {
  const chunks = chunkDiff(PATCH_3_FILES, 24_000);
  const alpha = chunks.find((chunk) => chunk.path === 'src/alpha.ts');
  assert.ok(alpha, 'expected a chunk for src/alpha.ts');
  assert.equal(alpha.language, 'TypeScript');
  assert.deepEqual(alpha.commentableLines, [2, 3, 22]);
  // The gutter the prompt tells the agent to quote from.
  assert.match(alpha.body, /^\s+2 \| \+const b = 3;$/m);
  assert.match(alpha.body, /^\s+22 \| \+added21$/m);
  // Removed lines are present for context but carry no number.
  assert.match(alpha.body, /^\s+- \| -const b = 2;$/m);
});

test('bundles the file name and language of a new file, numbering from the hunk header', () => {
  const chunks = chunkDiff(PATCH_3_FILES, 24_000);
  const python = chunks.find((chunk) => chunk.path === 'scripts/run.py');
  assert.ok(python, 'expected a chunk for scripts/run.py');
  assert.equal(python.language, 'Python');
  assert.deepEqual(python.commentableLines, [1, 2]);
});

test('drops binary sections and deletion-only files — neither has a line a comment could anchor to', () => {
  const paths = chunkDiff(PATCH_3_FILES, 24_000).map((chunk) => chunk.path);
  assert.deepEqual(paths.filter((path) => path === 'src/gone.ts' || path === 'assets/logo.png'), []);
  assert.deepEqual([...new Set(paths)], ['src/alpha.ts', 'scripts/run.py']);
});

test('an empty patch produces no chunks (nothing to review, no agent turn spent)', () => {
  assert.deepEqual(chunkDiff('', 24_000), []);
});

// git writes a blank context line as a single space; the empty string at the
// end of a patch is only the trailing newline, and counting it would render a
// context row for a line one past the end of the file.
test("the patch's trailing newline does not become a phantom line past the end of the file", () => {
  const chunks = chunkDiff(PATCH_3_FILES, 24_000);
  const python = chunks.find((chunk) => chunk.path === 'scripts/run.py');
  assert.ok(python);
  assert.equal(python.body.split('\n').length, 3, python.body); // hunk header + 2 added lines, nothing else
});

test('splits one oversized file into several chunks without losing a single added line', () => {
  const added = Array.from({ length: 200 }, (_, i) => `+line ${i + 1}`);
  const patch = ['diff --git a/src/big.ts b/src/big.ts', '--- /dev/null', '+++ b/src/big.ts', '@@ -0,0 +1,200 @@', ...added, ''].join('\n');

  const chunks = chunkDiff(patch, 400);
  assert.ok(chunks.length > 1, `expected the file to be split, got ${chunks.length} chunk(s)`);
  assert.deepEqual([...new Set(chunks.map((chunk) => chunk.path))], ['src/big.ts']);
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.commentableLines),
    Array.from({ length: 200 }, (_, i) => i + 1),
  );
  // Every chunk stays within budget and repeats the hunk header it split inside.
  for (const chunk of chunks) {
    assert.ok(chunk.body.length <= 400, `chunk of ${chunk.body.length} chars exceeds the budget`);
    assert.match(chunk.body, /@@ -0,0 \+1,200 @@/);
  }
});
