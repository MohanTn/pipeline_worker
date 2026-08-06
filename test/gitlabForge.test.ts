import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitlabForge, type GlabExecutor } from '../src/forge/gitlab.js';
import type { PipelineWorkerConfig } from '../src/types.js';

interface Call {
  args: string[];
  input?: string;
}

/** Fakes the `glab` CLI: each call consumes the next handler (the last handler repeats once exhausted), so tests never spawn a real glab binary. */
function fakeExecutor(handlers: Array<() => string>): { exec: GlabExecutor; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: GlabExecutor = async (args, input) => {
    calls.push({ args, input });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return handler();
  };
  return { exec, calls };
}

function gitlabConfig(): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'gitlab',
    gitlab: { host: 'https://gitlab.example.com', projectId: 1, token: 'test-token' },
    github: { repo: '', token: '', apiUrl: 'https://api.github.com' },
    build: '',
    lint: '',
    test: '',
    maxFixAttempts: 3,
    pollIntervalSeconds: 30,
    branchPattern: '{type}/{name}',
    cleanupOnSuccess: false,
    cleanupEarly: false,
  };
}

// hasMergeConflicts gates whether watchPipeline.ts's merge-conflict-resolution
// loop runs at all — a wrong answer here either skips a real conflict forever
// or wastes agent invocations resolving conflicts that don't exist.
test('hasMergeConflicts is true for GitLab "cannot_be_merged" (confirmed conflict)', async () => {
  const { exec } = fakeExecutor([() => JSON.stringify({ merge_status: 'cannot_be_merged' })]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  assert.equal(await forge.hasMergeConflicts(1), true);
});

for (const status of ['can_be_merged', 'unchecked', 'checking', 'cannot_be_merged_recheck', undefined]) {
  test(`hasMergeConflicts is false for GitLab merge_status ${JSON.stringify(status)} (not a confirmed conflict)`, async () => {
    const { exec } = fakeExecutor([() => JSON.stringify({ merge_status: status })]);
    const forge = createGitlabForge(gitlabConfig(), exec);
    assert.equal(await forge.hasMergeConflicts(1), false);
  });
}

// isMrMerged gates syncTargetBranch.ts's local fast-forward — reading
// "closed" (closed-without-merging) as merged would pull nothing and reading
// "merged" as unmerged would always time the sync out.
test('isMrMerged is true only for GitLab state "merged", not "closed"', async () => {
  for (const [state, expected] of [
    ['merged', true],
    ['closed', false],
    ['opened', false],
  ] as const) {
    const { exec } = fakeExecutor([() => JSON.stringify({ state })]);
    const forge = createGitlabForge(gitlabConfig(), exec);
    assert.equal(await forge.isMrMerged(1), expected, `state "${state}"`);
  }
});

/** Collects the `--field`/`--raw-field` key=value pairs out of a recorded glab argv. */
function fieldPairs(args: string[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--field' || args[i] === '--raw-field') pairs.push(`${args[i]} ${args[i + 1]}`);
  }
  return pairs;
}

test('updateMrDescription calls glab api PUT merge_requests/{iid} with the new description as a raw field', async () => {
  const { exec, calls } = fakeExecutor([() => '{}']);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await forge.updateMrDescription(7, 'refreshed description');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'projects/1/merge_requests/7']);
  assert.ok(calls[0].args.includes('-X') && calls[0].args.includes('PUT'));
  assert.ok(calls[0].args.includes('--hostname') && calls[0].args.includes('gitlab.example.com'));
  assert.deepEqual(fieldPairs(calls[0].args), ['--raw-field description=refreshed description']);
});

test('getMrDescription reads the description off GET merge_requests/{iid}, treating a null description as empty', async () => {
  const { exec, calls } = fakeExecutor([() => JSON.stringify({ description: 'Original description.', updated_at: '2024-01-01T00:00:00Z' }), () => JSON.stringify({ description: null, updated_at: '2024-01-02T00:00:00Z' })]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  const desc1 = await forge.getMrDescription(7);
  assert.equal(desc1.text, 'Original description.');
  assert.equal(desc1.version, '2024-01-01T00:00:00Z');
  const desc2 = await forge.getMrDescription(7);
  assert.equal(desc2.text, '');
  assert.equal(desc2.version, '2024-01-02T00:00:00Z');
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'projects/1/merge_requests/7']);
  assert.ok(!calls[0].args.includes('-X'));
});

/** A discussion GitLab anchored to the diff, as the API returns it: a hash id plus one DiffNote carrying the position back. */
function anchoredDiscussion(noteId: number, path: string, line: number): string {
  return JSON.stringify({
    id: 'a1b2c3',
    notes: [{ id: noteId, type: 'DiffNote', position: { position_type: 'text', new_path: path, new_line: line } }],
  });
}

// A GitLab discussion only lands on the diff when its position carries the
// MR's own base/start/head shas — a missing or stale triple is rejected, or
// (worse) silently posted as an ordinary MR-level note.
//
// The position must reach GitLab as a nested `position` hash, which rules out
// glab's fields: `--field 'position[new_line]=42'` puts the bracketed key
// verbatim into the JSON body glab builds, the API sees no position at all, and
// the comment silently becomes an MR-level thread. Bracketed query parameters
// are parsed into the nested hash, so the position belongs in the URL.
test('createInlineComment reads diff_refs off the MR, then POSTs the text position as nested query params', async () => {
  const { exec, calls } = fakeExecutor([
    () => JSON.stringify({ iid: 7, diff_refs: { base_sha: 'base1', start_sha: 'start1', head_sha: 'head1' } }),
    () => anchoredDiscussion(99, 'src/app.ts', 42),
  ]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  const note = await forge.createInlineComment(7, { path: 'src/app.ts', line: 42, body: 'Hard-coded secret.' });

  // The numeric note id, not the discussion's hash id.
  assert.deepEqual(note, { id: 99 });
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'projects/1/merge_requests/7']);
  assert.ok(calls[1].args.includes('-X') && calls[1].args.includes('POST'));

  const [endpoint, query] = calls[1].args[1].split('?');
  assert.equal(endpoint, 'projects/1/merge_requests/7/discussions');
  const position = new URLSearchParams(query);
  assert.deepEqual(
    [...position.entries()],
    [
      ['position[position_type]', 'text'],
      ['position[base_sha]', 'base1'],
      ['position[start_sha]', 'start1'],
      ['position[head_sha]', 'head1'],
      ['position[new_path]', 'src/app.ts'],
      ['position[old_path]', 'src/app.ts'],
      ['position[new_line]', '42'],
    ],
  );
  // Only the body stays a field — it is arbitrarily long and belongs nowhere near a URL.
  assert.deepEqual(fieldPairs(calls[1].args), ['--raw-field body=Hard-coded secret.']);
});

// Counting an unanchored note as posted is what produced a wall of MR-level
// comments instead of line comments: the run must hear about it.
test('createInlineComment rejects a discussion GitLab created without a diff position', async () => {
  const { exec } = fakeExecutor([
    () => JSON.stringify({ iid: 7, diff_refs: { base_sha: 'base1', start_sha: 'start1', head_sha: 'head1' } }),
    () => JSON.stringify({ id: 'a1b2c3', notes: [{ id: 99, type: 'DiscussionNote', position: null }] }),
  ]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await assert.rejects(
    () => forge.createInlineComment(7, { path: 'src/app.ts', line: 42, body: 'Hard-coded secret.' }),
    /without a diff position/,
  );
});

test('createInlineComment refuses to post at all when the MR reports no diff_refs to anchor to', async () => {
  const { exec, calls } = fakeExecutor([() => JSON.stringify({ iid: 7 })]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await assert.rejects(() => forge.createInlineComment(7, { path: 'src/app.ts', line: 42, body: 'x' }), /no diff_refs/);
  assert.equal(calls.length, 1, 'nothing is posted when the position cannot be built');
});

test('createGitlabForge transparently retries a call that fails with a transient 500', async () => {
  const { exec, calls } = fakeExecutor([
    () => {
      throw new Error('api call failed: 500 Internal Server Error');
    },
    () => JSON.stringify({ merge_status: 'can_be_merged' }),
  ]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  assert.equal(await forge.hasMergeConflicts(1), false);
  assert.equal(calls.length, 2);
});

test('enableAutoMerge PUTs merge_requests/{iid}/merge with merge_when_pipeline_succeeds and squash set per mergeMethod', async () => {
  const { exec, calls } = fakeExecutor([() => '{}']);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await forge.enableAutoMerge(7, 'squash');
  await forge.enableAutoMerge(7, 'merge');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[1], 'projects/1/merge_requests/7/merge');
  // `--field` (not `--raw-field`) so glab type-converts these to JSON booleans.
  assert.deepEqual(fieldPairs(calls[0].args), ['--field merge_when_pipeline_succeeds=true', '--field squash=true']);
  assert.deepEqual(fieldPairs(calls[1].args), ['--field merge_when_pipeline_succeeds=true', '--field squash=false']);
});

test('enableAutoMerge propagates a rejection (e.g. pending approvals) as a thrown error, without retrying a non-retryable status', async () => {
  const { exec, calls } = fakeExecutor([
    () => {
      throw new Error('api call failed: 405 Method Not Allowed');
    },
  ]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await assert.rejects(() => forge.enableAutoMerge(7, 'squash'), /405/);
  assert.equal(calls.length, 1);
});

test('approveMr POSTs merge_requests/{iid}/approve with no fields', async () => {
  const { exec, calls } = fakeExecutor([() => '{"id":7,"state":"opened"}']);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await forge.approveMr(7);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), ['api', 'projects/1/merge_requests/7/approve', '-X', 'POST']);
  assert.deepEqual(fieldPairs(calls[0].args), []);
});

test('approveMr propagates GitLab Free\'s 404 (approvals are a paid-tier API) as a thrown error the caller can note', async () => {
  const { exec } = fakeExecutor([
    () => {
      throw new Error('api call failed: 404 Not Found');
    },
  ]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await assert.rejects(() => forge.approveMr(7), /404/);
});

test('getCiConfigPath GETs the bare project endpoint and returns ci_config_path when set', async () => {
  const { exec, calls } = fakeExecutor([() => JSON.stringify({ id: 1, ci_config_path: 'ci/custom.yml' })]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  assert.equal(await forge.getCiConfigPath(), 'ci/custom.yml');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], 'projects/1');
});

for (const ciConfigPath of [null, undefined, '']) {
  test(`getCiConfigPath resolves undefined when ci_config_path is ${JSON.stringify(ciConfigPath)} (using the default path)`, async () => {
    const { exec } = fakeExecutor([() => JSON.stringify({ id: 1, ci_config_path: ciConfigPath })]);
    const forge = createGitlabForge(gitlabConfig(), exec);
    assert.equal(await forge.getCiConfigPath(), undefined);
  });
}

test('getJobLog returns the raw trace text from glab api', async () => {
  const { exec, calls } = fakeExecutor([() => 'line 1\nline 2\n']);
  const forge = createGitlabForge(gitlabConfig(), exec);
  assert.equal(await forge.getJobLog(42), 'line 1\nline 2\n');
  assert.equal(calls[0].args[1], 'projects/1/jobs/42/trace');
});

// Streaming a raw JSON body through `--input -` produces HTTP 415 on some
// GitLab installations and proxies, so the body must always travel as
// `--field`/`--raw-field` pairs (glab builds the request itself) and `--input`
// must never appear — nor any body flag on GETs and body-less POSTs.
test('GET requests pass no --input or field flags to glab', async () => {
  const { exec, calls } = fakeExecutor([() => '[]']);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await forge.findExistingMr('feat/branch');
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.includes('--input'));
  assert.deepEqual(fieldPairs(calls[0].args), []);
  assert.equal(calls[0].input, undefined);
});

test('body-less POST (retryPipeline) passes no --input or field flags to glab', async () => {
  const { exec, calls } = fakeExecutor([() => JSON.stringify({ id: 9, status: 'pending', web_url: '' })]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await forge.retryPipeline(9);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], 'projects/1/pipelines/9/retry');
  assert.ok(!calls[0].args.includes('--input'));
  assert.deepEqual(fieldPairs(calls[0].args), []);
  assert.equal(calls[0].input, undefined);
});

// The reply stage answers open threads only: a resolved discussion, and
// GitLab's own system notes ("added 3 commits"), are not something a reviewer
// can usefully answer — and re-answering a settled thread is how a bot becomes
// noise.
const DISCUSSIONS = JSON.stringify([
  { id: 'abc123', notes: [{ id: 1, system: true, body: 'added 3 commits', author: { username: 'alice' } }] },
  {
    id: 'def456',
    notes: [
      { id: 2, system: false, resolved: false, body: 'This leaks a token.', author: { username: 'alice' }, position: { new_path: 'src/app.ts', new_line: 42 } },
      { id: 3, system: false, resolved: false, body: 'Agreed.', author: { username: 'bob' } },
    ],
  },
  { id: 'ghi789', notes: [{ id: 4, system: false, resolved: true, body: 'settled', author: { username: 'carol' } }] },
  { id: 'jkl012', notes: [{ id: 5, system: false, resolved: false, body: 'SonarQube: 1 code smell.', author: { username: 'sonarqube-bot' } }] },
]);

test('listMrComments returns each open discussion as one text thread, dropping system notes and resolved threads', async () => {
  const { exec, calls } = fakeExecutor([() => DISCUSSIONS]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  const comments = await forge.listMrComments(7);

  assert.equal(calls[0].args[1], 'projects/1/merge_requests/7/discussions?per_page=100');
  assert.deepEqual(comments.map((comment) => comment.id), ['def456', 'jkl012']);
  assert.deepEqual(
    { author: comments[0].author, path: comments[0].path, line: comments[0].line, threadable: comments[0].threadable },
    { author: 'alice', path: 'src/app.ts', line: 42, threadable: true },
  );
  assert.match(comments[0].body, /This leaks a token\.\n\n--- reply from @bob\nAgreed\./);
  // An MR-level thread carries no diff anchor, and that is not a failure.
  assert.equal(comments[1].path, undefined);
});

test('replyToComment POSTs a note into the discussion it answers, with the body as a raw field', async () => {
  const { exec, calls } = fakeExecutor([() => JSON.stringify({ id: 99 })]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  const note = await forge.replyToComment(7, 'def456', 'This is not recommended because: it is validated upstream.');

  assert.deepEqual(note, { id: 99 });
  assert.equal(calls[0].args[1], 'projects/1/merge_requests/7/discussions/def456/notes');
  assert.ok(calls[0].args.includes('-X') && calls[0].args.includes('POST'));
  assert.deepEqual(fieldPairs(calls[0].args), ['--raw-field body=This is not recommended because: it is validated upstream.']);
});

test('POST with body passes --raw-field pairs, never --input or stdin', async () => {
  const { exec, calls } = fakeExecutor([
    () => JSON.stringify({ iid: 1, web_url: '', source_branch: 'feat/branch', target_branch: 'main', state: 'opened' }),
  ]);
  const forge = createGitlabForge(gitlabConfig(), exec);
  await forge.createMergeRequest({
    sourceBranch: 'feat/branch',
    targetBranch: 'main',
    title: 'title',
    description: 'desc',
  });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.includes('--input'));
  assert.equal(calls[0].input, undefined);
  assert.deepEqual(fieldPairs(calls[0].args), [
    '--raw-field source_branch=feat/branch',
    '--raw-field target_branch=main',
    '--raw-field title=title',
    '--raw-field description=desc',
  ]);
});
