import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { aggregateRuns, createGithubForge, type WorkflowRun } from '../src/forge/github.js';
import type { PipelineWorkerConfig } from '../src/types.js';

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return { id: 1, status: 'completed', conclusion: 'success', html_url: 'http://example/run/1', ...overrides };
}

test('aggregateRuns returns undefined for no runs (poller keeps waiting)', () => {
  assert.equal(aggregateRuns([]), undefined);
});

test('aggregateRuns reports running while any run is incomplete, even if another already failed', () => {
  const agg = aggregateRuns([run({ id: 1, conclusion: 'failure' }), run({ id: 2, status: 'in_progress', conclusion: null })]);
  assert.equal(agg?.status, 'running');
});

test('aggregateRuns surfaces the failed run (its id feeds getFailedJobs)', () => {
  const agg = aggregateRuns([run({ id: 1 }), run({ id: 2, conclusion: 'timed_out', html_url: 'http://example/run/2' })]);
  assert.deepEqual(agg, { id: 2, status: 'failed', webUrl: 'http://example/run/2' });
});

test('aggregateRuns is success when all runs pass or are skipped', () => {
  const agg = aggregateRuns([run({ id: 1 }), run({ id: 2, conclusion: 'skipped' })]);
  assert.equal(agg?.status, 'success');
});

test('aggregateRuns is skipped when every run was skipped', () => {
  const agg = aggregateRuns([run({ id: 1, conclusion: 'skipped' }), run({ id: 2, conclusion: 'neutral' })]);
  assert.equal(agg?.status, 'skipped');
});

test('aggregateRuns maps cancelled to canceled when nothing failed', () => {
  const agg = aggregateRuns([run({ id: 1 }), run({ id: 2, conclusion: 'cancelled' })]);
  assert.equal(agg?.status, 'canceled');
});

// hasMergeConflicts gates whether watchPipeline.ts's merge-conflict-resolution
// loop runs at all — a wrong answer here either skips a real conflict forever
// or wastes agent invocations resolving conflicts that don't exist.
function startPrStub(mergeableState: string | undefined): Promise<{ server: Server; port: number }> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ mergeable_state: mergeableState }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

/** Base URL the forge should talk to — pointed at the local stub by withGithubApi. */
let stubApiUrl = 'https://api.github.com';

function githubConfig(): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'github',
    gitlab: { host: '', projectId: 1 },
    github: { repo: 'acme/widgets', token: 'test-token', apiUrl: stubApiUrl },
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

/** Points every githubConfig() built inside fn at the local stub server (config.github.apiUrl — the forge reads no environment variables). */
async function withGithubApi(apiUrl: string, fn: () => Promise<void>): Promise<void> {
  const saved = stubApiUrl;
  stubApiUrl = apiUrl;
  try {
    await fn();
  } finally {
    stubApiUrl = saved;
  }
}

test('hasMergeConflicts is true for GitHub "dirty" (confirmed conflict)', async () => {
  const { server, port } = await startPrStub('dirty');
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      assert.equal(await forge.hasMergeConflicts(1), true);
    });
  } finally {
    server.close();
  }
});

// isMrMerged gates syncTargetBranch.ts's local fast-forward — GitHub's PR
// `state` reads "closed" for both merged and closed-without-merging, so only
// the `merged` flag can answer this.
function startMergedStub(merged: boolean | undefined): Promise<{ server: Server; port: number }> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ state: 'closed', merged }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

test('isMrMerged is true only when GitHub reports merged: true, even though state is "closed" either way', async () => {
  for (const [merged, expected] of [
    [true, true],
    [false, false],
    [undefined, false],
  ] as const) {
    const { server, port } = await startMergedStub(merged);
    try {
      await withGithubApi(`http://127.0.0.1:${port}`, async () => {
        const forge = createGithubForge(githubConfig());
        assert.equal(await forge.isMrMerged(1), expected, `merged: ${String(merged)}`);
      });
    } finally {
      server.close();
    }
  }
});

test('updateMrDescription PATCHes /pulls/{iid} with the new body', async () => {
  const requests: Array<{ method?: string; path?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      await forge.updateMrDescription(42, 'new description');
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'PATCH');
    assert.equal(requests[0].path, '/repos/acme/widgets/pulls/42');
    assert.deepEqual(requests[0].body, { body: 'new description' });
  } finally {
    server.close();
  }
});

test('getMrDescription reads the PR body, and reads an absent body as an empty string', async () => {
  for (const [body, expected] of [['Original description.', 'Original description.'], [null, '']] as Array<[string | null, string]>) {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ body }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await withGithubApi(`http://127.0.0.1:${port}`, async () => {
        const forge = createGithubForge(githubConfig());
        const result = await forge.getMrDescription(42);
        assert.equal(result.text, expected);
      });
    } finally {
      server.close();
    }
  }
});

test('createGithubForge transparently retries a transient 500 via forgeFetch', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ mergeable_state: 'clean' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      assert.equal(await forge.hasMergeConflicts(1), false);
    });
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});

/** Routes GET /repos/.../pulls/{n} to `nodeId` and POST /graphql to `graphqlHandler`, capturing every request made. */
function startAutoMergeStub(nodeId: string, graphqlHandler: (body: unknown) => { status: number; body: unknown }): Promise<{ server: Server; port: number; requests: Array<{ method?: string; path?: string; body: unknown }> }> {
  const requests: Array<{ method?: string; path?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/graphql')) {
        const { status, body: respBody } = graphqlHandler(body);
        res.writeHead(status);
        res.end(JSON.stringify(respBody));
        return;
      }
      res.end(JSON.stringify({ node_id: nodeId }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, requests });
    });
  });
}

test('enableAutoMerge fetches the PR node_id then sends the enablePullRequestAutoMerge GraphQL mutation', async () => {
  const { server, port, requests } = await startAutoMergeStub('PR_kwabc123', () => ({ status: 200, body: { data: { enablePullRequestAutoMerge: { clientMutationId: null } } } }));
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      await forge.enableAutoMerge(42, 'squash');
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].path, '/repos/acme/widgets/pulls/42');
    assert.equal(requests[1].path, '/graphql');
    const graphqlBody = requests[1].body as { query: string; variables: { pullRequestId: string; mergeMethod: string } };
    assert.match(graphqlBody.query, /enablePullRequestAutoMerge/);
    assert.equal(graphqlBody.variables.pullRequestId, 'PR_kwabc123');
    assert.equal(graphqlBody.variables.mergeMethod, 'SQUASH');
  } finally {
    server.close();
  }
});

test('enableAutoMerge throws when the GraphQL response reports errors', async () => {
  const { server, port } = await startAutoMergeStub('PR_kwabc123', () => ({
    status: 200,
    body: { errors: [{ message: 'Pull request Auto merge is not allowed for this repository' }] },
  }));
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      await assert.rejects(() => forge.enableAutoMerge(42, 'merge'), /Auto merge is not allowed/);
    });
  } finally {
    server.close();
  }
});

/** Serves the PR (for its head sha) and records every request, so the comment POST can be asserted in full. */
function startInlineCommentStub(headSha: string): Promise<{ server: Server; port: number; requests: Array<{ method?: string; path?: string; body: unknown }> }> {
  const requests: Array<{ method?: string; path?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.method === 'POST' ? { id: 555 } : { head: { sha: headSha } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, requests });
    });
  });
}

// A review comment against anything but the PR's current head sha is filed as
// "outdated" and collapsed out of sight — the one thing this feature must not do.
test('createInlineComment resolves the PR head sha, then POSTs a RIGHT-side comment on that path and line', async () => {
  const { server, port, requests } = await startInlineCommentStub('abc123head');
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      const comment = await forge.createInlineComment(7, { path: 'src/app.ts', line: 42, body: 'Hard-coded secret.' });
      assert.deepEqual(comment, { id: 555 });
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].path, '/repos/acme/widgets/pulls/7');
    assert.equal(requests[1].method, 'POST');
    assert.equal(requests[1].path, '/repos/acme/widgets/pulls/7/comments');
    assert.deepEqual(requests[1].body, {
      commit_id: 'abc123head',
      path: 'src/app.ts',
      line: 42,
      side: 'RIGHT',
      body: 'Hard-coded secret.',
    });
  } finally {
    server.close();
  }
});

test('getCiConfigPath always resolves undefined with no HTTP request — GitHub has no custom-path concept', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    res.writeHead(500);
    res.end('should never be reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      assert.equal(await forge.getCiConfigPath(), undefined);
    });
    assert.equal(calls, 0);
  } finally {
    server.close();
  }
});

// listMrComments has to read two GitHub surfaces at once: review threads come
// from GraphQL (the only place `isResolved` exists, so settled threads are not
// answered again) and the PR-level comments scanner bots post come from REST.
function startCommentsStub(graphqlBody: unknown, issueComments: unknown): Promise<{ server: Server; port: number; requests: Array<{ method?: string; path?: string; body: unknown }> }> {
  const requests: Array<{ method?: string; path?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/graphql') res.end(JSON.stringify(graphqlBody));
      else if (req.method === 'POST') res.end(JSON.stringify({ id: 777 }));
      else res.end(JSON.stringify(issueComments));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, requests });
    });
  });
}

const REVIEW_THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              comments: {
                nodes: [
                  { databaseId: 11, body: 'This leaks a token.', path: 'src/app.ts', line: 42, url: 'http://example/c/11', author: { login: 'alice' } },
                  { databaseId: 12, body: 'Agreed.', path: 'src/app.ts', line: 42, url: 'http://example/c/12', author: { login: 'bob' } },
                ],
              },
            },
            { isResolved: true, comments: { nodes: [{ databaseId: 20, body: 'settled', path: 'a.ts', line: 1, url: null, author: { login: 'carol' } }] } },
          ],
        },
      },
    },
  },
};

test('listMrComments returns unresolved review threads as one text thread each, plus the PR-level comments scanners post', async () => {
  const { server, port, requests } = await startCommentsStub(REVIEW_THREADS, [
    { id: 55, body: 'SonarQube: 1 code smell.', html_url: 'http://example/i/55', user: { login: 'sonarqube[bot]' } },
  ]);
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      const comments = await forge.listMrComments(7);

      assert.equal(comments.length, 2, 'the resolved thread must not come back');
      // The thread's FIRST comment id is the reply target; the whole thread is the body.
      assert.deepEqual(
        { id: comments[0].id, author: comments[0].author, path: comments[0].path, line: comments[0].line, threadable: comments[0].threadable },
        { id: '11', author: 'alice', path: 'src/app.ts', line: 42, threadable: true },
      );
      assert.match(comments[0].body, /This leaks a token\.\n\n--- reply from @bob\nAgreed\./);
      assert.deepEqual(
        { id: comments[1].id, author: comments[1].author, threadable: comments[1].threadable },
        { id: 'issue:55', author: 'sonarqube[bot]', threadable: false },
      );
    });
    assert.equal(requests[0].path, '/graphql');
    assert.equal(requests[1].path, '/repos/acme/widgets/issues/7/comments?per_page=100');
  } finally {
    server.close();
  }
});

test('replyToComment threads under a review comment, and falls back to a new PR-level comment for one that cannot be threaded', async () => {
  const { server, port, requests } = await startCommentsStub(REVIEW_THREADS, []);
  try {
    await withGithubApi(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      assert.deepEqual(await forge.replyToComment(7, '11', 'not so'), { id: 777 });
      await forge.replyToComment(7, 'issue:55', 'not so either');
    });
    assert.equal(requests[0].path, '/repos/acme/widgets/pulls/7/comments/11/replies');
    assert.deepEqual(requests[0].body, { body: 'not so' });
    assert.equal(requests[1].path, '/repos/acme/widgets/issues/7/comments');
  } finally {
    server.close();
  }
});

for (const state of ['clean', 'unstable', 'blocked', 'behind', 'draft', 'unknown', undefined]) {
  test(`hasMergeConflicts is false for GitHub mergeable_state ${JSON.stringify(state)} (not a real conflict)`, async () => {
    const { server, port } = await startPrStub(state);
    try {
      await withGithubApi(`http://127.0.0.1:${port}`, async () => {
        const forge = createGithubForge(githubConfig());
        assert.equal(await forge.hasMergeConflicts(1), false);
      });
    } finally {
      server.close();
    }
  });
}
