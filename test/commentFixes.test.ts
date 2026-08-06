import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommentFixPrompt, gateFixes, parseFixes, renderFixBody, type CommentFix } from '../src/review/commentFixes.js';
import { scannerLabel } from '../src/review/commentReplies.js';
import type { MrComment } from '../src/forge/types.js';

function comment(overrides: Partial<MrComment> = {}): MrComment {
  return { id: 'd1', author: 'alice', body: 'This hard-codes a secret.', path: 'app.ts', line: 1, threadable: true, ...overrides };
}

test('the prompt tells the agent to edit the code, and never to claim a fix it did not make', () => {
  const prompt = buildCommentFixPrompt([comment()], '--- File: app.ts\n1 | const a = 1;', '```suggestion:-0+0');
  assert.match(prompt, /### Thread 1 — @alice on app\.ts:1/);
  assert.match(prompt, /FIX IT IN THE CODE/);
  assert.match(prompt, /Do not commit, do not push/);
  assert.match(prompt, /Never report a thread as "fixed" unless you actually edited a file/);
  assert.match(prompt, /This is not recommended because:/);
  assert.match(prompt, /--- File: app\.ts/);
});

test('CodeRabbit is recognized as a bot thread, like the scanners', () => {
  assert.equal(scannerLabel(comment({ author: 'coderabbitai[bot]' })), 'CodeRabbit');
  assert.equal(scannerLabel(comment({ author: 'ci-token', body: 'CodeRabbit: consider extracting this.' })), 'CodeRabbit');
});

test('prose parses to no decisions, and both payload shapes parse', () => {
  assert.deepEqual(parseFixes('I fixed everything, trust me.'), []);
  const wrapped = parseFixes('Done: {"fixes":[{"thread":1,"action":"fixed","severity":"MAJOR","message":"Read it from env in app.ts."}]}');
  assert.deepEqual(wrapped, [{ thread: 1, action: 'fixed', severity: 'MAJOR', message: 'Read it from env in app.ts.' }]);
  assert.equal(parseFixes('[{"thread":1,"action":"invalid","severity":"MINOR","message":"no"}]').length, 1);
  assert.deepEqual(parseFixes('{"fixes":[{"thread":1,"action":"maybe","severity":"MAJOR","message":"x"}]}'), [], 'an unknown action is not a decision');
});

test('the gate drops unknown threads, keeps one decision per thread, and caps the run severest-first', () => {
  const comments = [comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })];
  const fixes: CommentFix[] = [
    { thread: 9, action: 'fixed', severity: 'CRITICAL', message: 'hallucinated' },
    { thread: 1, action: 'fixed', severity: 'MINOR', message: 'first' },
    { thread: 1, action: 'invalid', severity: 'CRITICAL', message: 'second on the same thread' },
    { thread: 3, action: 'invalid', severity: 'CRITICAL', message: 'third' },
  ];
  const kept = gateFixes(fixes, comments, 2);
  assert.deepEqual(
    kept.map((entry) => entry.comment.id),
    ['c', 'a'],
    'severest first, one per thread, unknown thread dropped',
  );
  assert.deepEqual(gateFixes(fixes, comments, 0), []);
});

test('a MINOR decision is kept — fix has no severity floor, unlike the reply stage', () => {
  const kept = gateFixes([{ thread: 1, action: 'fixed', severity: 'MINOR', message: 'renamed it' }], [comment()], 10);
  assert.equal(kept.length, 1);
});

test('a fix reply names the commit, a rebuttal leads with the correction, both are signed', () => {
  const fixed = renderFixBody({ comment: comment(), fix: { thread: 1, action: 'fixed', severity: 'MAJOR', message: 'Read it from env.' } }, 'gitlab', 'claude', 'a1b2c3d');
  assert.match(fixed, /^Fixed in `a1b2c3d`: Read it from env\./);
  assert.match(fixed, /_MAJOR · pipeline-worker fix \(claude\)_$/);

  const refuted = renderFixBody({ comment: comment(), fix: { thread: 1, action: 'invalid', severity: 'MINOR', message: 'utils.ts is not on this branch.' } }, 'gitlab', 'claude');
  assert.match(refuted, /^This is not recommended because: utils\.ts is not on this branch\./);

  const already = renderFixBody(
    { comment: comment(), fix: { thread: 1, action: 'invalid', severity: 'MINOR', message: 'This is not recommended because: it is already handled.' } },
    'gitlab',
    'claude',
  );
  assert.equal(already.split('This is not recommended because:').length, 2, 'the lead is never doubled');
});

test('an unthreadable comment is quoted into the reply, since the forge cannot nest it', () => {
  const body = renderFixBody(
    { comment: comment({ threadable: false, author: 'sonarqube[bot]', url: 'https://example/c/1' }), fix: { thread: 1, action: 'fixed', severity: 'MAJOR', message: 'done' } },
    'github',
    'claude',
    'abc1234',
  );
  assert.match(body, /^> Replying to \[@sonarqube\[bot\]'s comment\]\(https:\/\/example\/c\/1\)/);
});
