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
    gitlab: { host: 'https://gitlab.example.com', projectId: 1 },
    github: { repo: '' },
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

// hasMergeConflicts gates whether watchPipeline.ts's merge-conflict-resolution
// loop runs at all — a wrong answer here either skips a real conflict forever
// or wastes agent invocations resolving conflicts that don't exist.
test('hasMergeConflicts is true for GitLab "cannot_be_merged" (confirmed conflict)', async () => {
  await withGitlabEnv(async () => {
    const { exec } = fakeExecutor([() => JSON.stringify({ merge_status: 'cannot_be_merged' })]);
    const forge = createGitlabForge(gitlabConfig(), exec);
    assert.equal(await forge.hasMergeConflicts(1), true);
  });
});

for (const status of ['can_be_merged', 'unchecked', 'checking', 'cannot_be_merged_recheck', undefined]) {
  test(`hasMergeConflicts is false for GitLab merge_status ${JSON.stringify(status)} (not a confirmed conflict)`, async () => {
    await withGitlabEnv(async () => {
      const { exec } = fakeExecutor([() => JSON.stringify({ merge_status: status })]);
      const forge = createGitlabForge(gitlabConfig(), exec);
      assert.equal(await forge.hasMergeConflicts(1), false);
    });
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
    await withGitlabEnv(async () => {
      const { exec } = fakeExecutor([() => JSON.stringify({ state })]);
      const forge = createGitlabForge(gitlabConfig(), exec);
      assert.equal(await forge.isMrMerged(1), expected, `state "${state}"`);
    });
  }
});

test('updateMrDescription calls glab api PUT merge_requests/{iid} with the new description on stdin', async () => {
  await withGitlabEnv(async () => {
    const { exec, calls } = fakeExecutor([() => '{}']);
    const forge = createGitlabForge(gitlabConfig(), exec);
    await forge.updateMrDescription(7, 'refreshed description');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 2), ['api', 'projects/1/merge_requests/7']);
    assert.ok(calls[0].args.includes('-X') && calls[0].args.includes('PUT'));
    assert.ok(calls[0].args.includes('--hostname') && calls[0].args.includes('gitlab.example.com'));
    assert.deepEqual(calls[0].input && JSON.parse(calls[0].input), { description: 'refreshed description' });
  });
});

test('createGitlabForge transparently retries a call that fails with a transient 500', async () => {
  await withGitlabEnv(async () => {
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
});

test('enableAutoMerge PUTs merge_requests/{iid}/merge with merge_when_pipeline_succeeds and squash set per mergeMethod', async () => {
  await withGitlabEnv(async () => {
    const { exec, calls } = fakeExecutor([() => '{}']);
    const forge = createGitlabForge(gitlabConfig(), exec);
    await forge.enableAutoMerge(7, 'squash');
    await forge.enableAutoMerge(7, 'merge');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args[1], 'projects/1/merge_requests/7/merge');
    assert.deepEqual(calls[0].input && JSON.parse(calls[0].input), { merge_when_pipeline_succeeds: true, squash: true });
    assert.deepEqual(calls[1].input && JSON.parse(calls[1].input), { merge_when_pipeline_succeeds: true, squash: false });
  });
});

test('enableAutoMerge propagates a rejection (e.g. pending approvals) as a thrown error, without retrying a non-retryable status', async () => {
  await withGitlabEnv(async () => {
    const { exec, calls } = fakeExecutor([
      () => {
        throw new Error('api call failed: 405 Method Not Allowed');
      },
    ]);
    const forge = createGitlabForge(gitlabConfig(), exec);
    await assert.rejects(() => forge.enableAutoMerge(7, 'squash'), /405/);
    assert.equal(calls.length, 1);
  });
});

test('getCiConfigPath GETs the bare project endpoint and returns ci_config_path when set', async () => {
  await withGitlabEnv(async () => {
    const { exec, calls } = fakeExecutor([() => JSON.stringify({ id: 1, ci_config_path: 'ci/custom.yml' })]);
    const forge = createGitlabForge(gitlabConfig(), exec);
    assert.equal(await forge.getCiConfigPath(), 'ci/custom.yml');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], 'projects/1');
  });
});

for (const ciConfigPath of [null, undefined, '']) {
  test(`getCiConfigPath resolves undefined when ci_config_path is ${JSON.stringify(ciConfigPath)} (using the default path)`, async () => {
    await withGitlabEnv(async () => {
      const { exec } = fakeExecutor([() => JSON.stringify({ id: 1, ci_config_path: ciConfigPath })]);
      const forge = createGitlabForge(gitlabConfig(), exec);
      assert.equal(await forge.getCiConfigPath(), undefined);
    });
  });
}

test('getJobLog returns the raw trace text from glab api', async () => {
  await withGitlabEnv(async () => {
    const { exec, calls } = fakeExecutor([() => 'line 1\nline 2\n']);
    const forge = createGitlabForge(gitlabConfig(), exec);
    assert.equal(await forge.getJobLog(42), 'line 1\nline 2\n');
    assert.equal(calls[0].args[1], 'projects/1/jobs/42/trace');
  });
});

// GitLab (Grape) rejects a request whose Content-Type declares JSON but whose
// body is empty with HTTP 415 — seen on self-hosted/proxied instances — so a
// body (glab's `--input -`) must appear exactly when one is sent, never on
// GETs or body-less POSTs.
test('GET requests pass no --input/body to glab', async () => {
  await withGitlabEnv(async () => {
    const { exec, calls } = fakeExecutor([() => '[]']);
    const forge = createGitlabForge(gitlabConfig(), exec);
    await forge.findExistingMr('feat/branch');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].args.includes('--input'));
    assert.equal(calls[0].input, undefined);
  });
});

test('body-less POST (retryPipeline) passes no --input/body to glab', async () => {
  await withGitlabEnv(async () => {
    const { exec, calls } = fakeExecutor([() => JSON.stringify({ id: 9, status: 'pending', web_url: '' })]);
    const forge = createGitlabForge(gitlabConfig(), exec);
    await forge.retryPipeline(9);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], 'projects/1/pipelines/9/retry');
    assert.ok(!calls[0].args.includes('--input'));
    assert.equal(calls[0].input, undefined);
  });
});

test('POST with body passes --input - and the JSON body on stdin', async () => {
  await withGitlabEnv(async () => {
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
    assert.ok(calls[0].args.includes('--input') && calls[0].args.includes('-'));
    assert.deepEqual(calls[0].input && JSON.parse(calls[0].input), {
      source_branch: 'feat/branch',
      target_branch: 'main',
      title: 'title',
      description: 'desc',
    });
  });
});
