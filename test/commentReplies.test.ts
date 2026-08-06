import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRECTION_LEAD,
  buildCommentReplyPrompt,
  gateReplies,
  isOwnComment,
  parseReplies,
  renderReplyBody,
  renderThreads,
  scannerLabel,
  type CommentReply,
} from '../src/review/commentReplies.js';
import type { MrComment } from '../src/forge/types.js';

function comment(overrides: Partial<MrComment> = {}): MrComment {
  return { id: 'd1', author: 'alice', body: 'This leaks a token.', path: 'app.ts', line: 1, threadable: true, ...overrides };
}

test('isOwnComment recognizes pipeline-worker\'s own review comments and replies, so a second run does not argue with itself', () => {
  assert.equal(isOwnComment(comment({ body: '### Secret\n\nmove it\n\n_CRITICAL · pipeline-worker review (claude)_' })), true);
  assert.equal(isOwnComment(comment({ body: 'no\n\n_MAJOR · pipeline-worker reply (claude)_' })), true);
  assert.equal(isOwnComment(comment({ body: 'a human wrote this' })), false);
});

test('scannerLabel identifies SonarQube and Checkmarx by author or by body, and nobody else', () => {
  assert.equal(scannerLabel(comment({ author: 'sonarqubebot' })), 'SonarQube');
  assert.equal(scannerLabel(comment({ author: 'sonarcloud[bot]' })), 'SonarQube');
  assert.equal(scannerLabel(comment({ author: 'checkmarx-one' })), 'Checkmarx');
  // A scanner posting through a generic CI token is recognized by what it says.
  assert.equal(scannerLabel(comment({ author: 'ci-bot', body: 'Checkmarx One found 1 high severity issue.' })), 'Checkmarx');
  assert.equal(scannerLabel(comment({ author: 'alice', body: 'looks fine' })), undefined);
});

test('renderThreads numbers every thread and labels its anchor and scanner — the numbering the agent answers against', () => {
  const rendered = renderThreads([
    comment({ author: 'alice', path: 'app.ts', line: 12 }),
    comment({ id: 'issue:5', author: 'sonarqube[bot]', body: 'Code smell: unused import.', path: undefined, line: undefined, threadable: false }),
  ]);
  assert.match(rendered, /### Thread 1 — @alice on app\.ts:12/);
  assert.match(rendered, /### Thread 2 — @sonarqube\[bot\] \[SonarQube scanner\] \(not anchored to a line\)/);
});

test('the prompt states the configured floor, the correction opening, and the forge suggestion fence', () => {
  const prompt = buildCommentReplyPrompt([comment()], '--- File: app.ts\n1 | const a = 1;', 'CRITICAL', '```suggestion:-0+0');
  assert.match(prompt, /whose severity is CRITICAL or worse/);
  assert.match(prompt, new RegExp(CORRECTION_LEAD));
  assert.match(prompt, /```suggestion:-0\+0/);
  assert.match(prompt, /### Thread 1 — @alice/);
});

test('parseReplies salvages JSON wrapped in prose and returns nothing for an unusable answer', () => {
  const replies = parseReplies('Sure! {"replies":[{"thread":1,"kind":"support","severity":"MAJOR","reply":"Yes, and here is the fix."}]}');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].kind, 'support');
  assert.deepEqual(parseReplies('I think everything is fine here.'), []);
  // A payload that fails the shape check contributes nothing rather than throwing.
  assert.deepEqual(parseReplies('{"replies":[{"thread":0,"kind":"whatever"}]}'), []);
});

test('gateReplies drops a support reply under the floor but keeps a correction at any severity', () => {
  const comments = [comment({ id: 'a' }), comment({ id: 'b' })];
  const replies: CommentReply[] = [
    { thread: 1, kind: 'support', severity: 'MINOR', reply: 'agreed' },
    { thread: 2, kind: 'correct', severity: 'MINOR', reply: 'wrong line' },
  ];
  const kept = gateReplies(replies, comments, 'MAJOR', 10);
  assert.deepEqual(kept.map((entry) => entry.comment.id), ['b'], 'a misdirection is corrected regardless of how serious it is');
});

test('gateReplies ignores a thread number the prompt never showed and answers each thread once', () => {
  const comments = [comment({ id: 'a' })];
  const replies: CommentReply[] = [
    { thread: 9, kind: 'correct', severity: 'CRITICAL', reply: 'about a thread that does not exist' },
    { thread: 1, kind: 'support', severity: 'CRITICAL', reply: 'first' },
    { thread: 1, kind: 'support', severity: 'CRITICAL', reply: 'second' },
  ];
  const kept = gateReplies(replies, comments, 'MAJOR', 10);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reply.reply, 'first');
});

test('gateReplies sorts most severe first and caps the run', () => {
  const comments = [comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })];
  const replies: CommentReply[] = [
    { thread: 1, kind: 'support', severity: 'MAJOR', reply: 'a' },
    { thread: 2, kind: 'support', severity: 'CRITICAL', reply: 'b' },
    { thread: 3, kind: 'support', severity: 'MAJOR', reply: 'c' },
  ];
  const kept = gateReplies(replies, comments, 'MAJOR', 2);
  assert.deepEqual(kept.map((entry) => entry.comment.id), ['b', 'a']);
});

test('a correction always opens with the required lead, even when the agent forgot it', () => {
  const body = renderReplyBody(
    { comment: comment(), reply: { thread: 1, kind: 'correct', severity: 'MAJOR', reply: 'The null check belongs in the caller.' } },
    'github',
    'claude',
  );
  assert.ok(body.startsWith(`${CORRECTION_LEAD} The null check belongs in the caller.`));
  assert.match(body, /_MAJOR · pipeline-worker reply \(claude\)_/);
});

test('a correction the agent already opened correctly is not double-prefixed', () => {
  const body = renderReplyBody(
    { comment: comment(), reply: { thread: 1, kind: 'correct', severity: 'MAJOR', reply: `${CORRECTION_LEAD} the field is validated upstream.` } },
    'github',
    'claude',
  );
  assert.equal(body.indexOf(CORRECTION_LEAD), body.lastIndexOf(CORRECTION_LEAD));
});

test('a reply to an unthreadable comment quotes the original, since it lands as a new top-level comment', () => {
  const body = renderReplyBody(
    {
      comment: comment({ id: 'issue:5', author: 'sonarqube[bot]', url: 'https://github.example/pr/1#issuecomment-5', threadable: false }),
      reply: { thread: 1, kind: 'support', severity: 'CRITICAL', reply: 'Confirmed.' },
    },
    'github',
    'claude',
  );
  assert.match(body, /^> Replying to \[@sonarqube\[bot\]'s comment\]\(https:\/\/github\.example\/pr\/1#issuecomment-5\)/);
});

test('a threaded reply carries no quote, and its suggestion fence is rewritten for the forge', () => {
  const body = renderReplyBody(
    { comment: comment(), reply: { thread: 1, kind: 'support', severity: 'MAJOR', reply: 'Fix:\n```suggestion\nconst a = 2;\n```' } },
    'gitlab',
    'claude',
  );
  assert.ok(!body.startsWith('>'));
  assert.match(body, /```suggestion:-0\+0/);
});
