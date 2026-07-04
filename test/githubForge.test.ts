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
