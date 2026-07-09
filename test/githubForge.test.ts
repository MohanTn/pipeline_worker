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

function githubConfig(): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'github',
    gitlab: { host: '', projectId: 1 },
    github: { repo: 'acme/widgets' },
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

/** Sets the two env vars resolveGithubAuth reads, restoring their prior values afterward — process.env is shared across every test file in this run. */
async function withGithubEnv(apiUrl: string, fn: () => Promise<void>): Promise<void> {
  const savedApiUrl = process.env.PIPELINE_WORKER_GITHUB_API_URL;
  const savedToken = process.env.PIPELINE_WORKER_GITHUB_TOKEN;
  process.env.PIPELINE_WORKER_GITHUB_API_URL = apiUrl;
  process.env.PIPELINE_WORKER_GITHUB_TOKEN = 'test-token';
  try {
    await fn();
  } finally {
    if (savedApiUrl === undefined) delete process.env.PIPELINE_WORKER_GITHUB_API_URL;
    else process.env.PIPELINE_WORKER_GITHUB_API_URL = savedApiUrl;
    if (savedToken === undefined) delete process.env.PIPELINE_WORKER_GITHUB_TOKEN;
    else process.env.PIPELINE_WORKER_GITHUB_TOKEN = savedToken;
  }
}

test('hasMergeConflicts is true for GitHub "dirty" (confirmed conflict)', async () => {
  const { server, port } = await startPrStub('dirty');
  try {
    await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
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
      await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
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
    await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
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
    await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
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
    await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
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
    await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      await assert.rejects(() => forge.enableAutoMerge(42, 'merge'), /Auto merge is not allowed/);
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
    await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
      const forge = createGithubForge(githubConfig());
      assert.equal(await forge.getCiConfigPath(), undefined);
    });
    assert.equal(calls, 0);
  } finally {
    server.close();
  }
});

for (const state of ['clean', 'unstable', 'blocked', 'behind', 'draft', 'unknown', undefined]) {
  test(`hasMergeConflicts is false for GitHub mergeable_state ${JSON.stringify(state)} (not a real conflict)`, async () => {
    const { server, port } = await startPrStub(state);
    try {
      await withGithubEnv(`http://127.0.0.1:${port}`, async () => {
        const forge = createGithubForge(githubConfig());
        assert.equal(await forge.hasMergeConflicts(1), false);
      });
    } finally {
      server.close();
    }
  });
}
