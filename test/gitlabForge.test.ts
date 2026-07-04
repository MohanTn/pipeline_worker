import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { createGitlabForge } from '../src/forge/gitlab.js';
import type { PipelineWorkerConfig } from '../src/types.js';

// hasMergeConflicts gates whether watchPipeline.ts's merge-conflict-resolution
// loop runs at all — a wrong answer here either skips a real conflict forever
// or wastes agent invocations resolving conflicts that don't exist.
function startMrStub(mergeStatus: string | undefined): Promise<{ server: Server; port: number }> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ merge_status: mergeStatus }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function gitlabConfig(host: string): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'gitlab',
    gitlab: { host, projectId: 1 },
    github: { repo: '' },
    build: '',
    lint: '',
    test: '',
    maxFixAttempts: 3,
    pollIntervalSeconds: 30,
    branchPattern: '{type}/{name}',
    cleanupOnSuccess: false,
  };
}

/** Sets the env var resolveGitlabAuth reads, restoring its prior value afterward — process.env is shared across every test file in this run. */
async function withGitlabEnv(fn: () => Promise<void>): Promise<void> {
  const savedToken = process.env.PIPELINE_WORKER_GITLAB_TOKEN;
  process.env.PIPELINE_WORKER_GITLAB_TOKEN = 'test-token';
  try {
    await fn();
  } finally {
    if (savedToken === undefined) delete process.env.PIPELINE_WORKER_GITLAB_TOKEN;
    else process.env.PIPELINE_WORKER_GITLAB_TOKEN = savedToken;
  }
}

test('hasMergeConflicts is true for GitLab "cannot_be_merged" (confirmed conflict)', async () => {
  const { server, port } = await startMrStub('cannot_be_merged');
  try {
    await withGitlabEnv(async () => {
      const forge = createGitlabForge(gitlabConfig(`http://127.0.0.1:${port}`));
      assert.equal(await forge.hasMergeConflicts(1), true);
    });
  } finally {
    server.close();
  }
});

for (const status of ['can_be_merged', 'unchecked', 'checking', 'cannot_be_merged_recheck', undefined]) {
  test(`hasMergeConflicts is false for GitLab merge_status ${JSON.stringify(status)} (not a confirmed conflict)`, async () => {
    const { server, port } = await startMrStub(status);
    try {
      await withGitlabEnv(async () => {
        const forge = createGitlabForge(gitlabConfig(`http://127.0.0.1:${port}`));
        assert.equal(await forge.hasMergeConflicts(1), false);
      });
    } finally {
      server.close();
    }
  });
}
