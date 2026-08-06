import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { maybeReplyToMrComments } from '../src/workflow/replyMrComments.js';
import type { AgentAdapter, AgentInvokeOptions } from '../src/agent/types.js';
import type { ForgeClient, MrComment } from '../src/forge/types.js';
import type { PipelineWorkerConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);

function replyConfig(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'gitlab',
    gitlab: { host: '', projectId: 1 },
    github: { repo: '' },
    build: '',
    lint: '',
    test: '',
    maxFixAttempts: 3,
    pollIntervalSeconds: 30,
    intentModel: 'haiku',
    branchPattern: '{type}/{name}',
    cleanupOnSuccess: false,
    cleanupEarly: false,
    runLintAndTest: false,
    updateChangelog: false,
    autoMergeOnGreen: false,
    mergeMethod: 'squash',
    squashOnMerge: false,
    completionSound: false,
    review: true,
    reviewModel: '',
    reviewMinSeverity: 'MAJOR',
    reviewMaxComments: 10,
    reviewChunkChars: 200_000,
    reviewFilesPerTurn: 0,
    littleCoder: { binary: 'little-coder', maxPromptChars: 12_000 },
    ...overrides,
  } as PipelineWorkerConfig;
}

/** A repo whose feature branch adds one file on top of origin/main — the diff the reply stage shows the agent. */
async function makeReviewableBranch(): Promise<{ worktreePath: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-reply-origin-'));
  const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-reply-repo-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: worktreePath });
  writeFileSync(join(worktreePath, 'base.txt'), 'base\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: worktreePath });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: worktreePath });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['checkout', '-q', '-b', 'feature/reviewed'], { cwd: worktreePath });
  writeFileSync(join(worktreePath, 'app.ts'), 'const token = "hunter2";\nexport const port = 8080;\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'feat: add app'], { cwd: worktreePath });
  return { worktreePath, originDir };
}

function agentReturning(text: string, calls: AgentInvokeOptions[] = []): AgentAdapter {
  return {
    invoke: async (opts) => {
      calls.push(opts);
      return { text };
    },
  };
}

const NEVER_INVOKED: AgentAdapter = {
  invoke: async () => {
    throw new Error('the agent must not be invoked');
  },
};

function mrComment(overrides: Partial<MrComment> = {}): MrComment {
  return { id: 'd1', author: 'alice', body: 'This hard-codes a secret.', path: 'app.ts', line: 1, threadable: true, ...overrides };
}

/** A forge that answers everything harmlessly; each test overwrites the one method it cares about. */
function forgeStub(comments: MrComment[] = []): ForgeClient {
  return {
    findExistingMr: async () => undefined,
    createMergeRequest: async () => {
      throw new Error('not used');
    },
    updateMrDescription: async () => {},
    getMrDescription: async () => ({ text: '' }),
    getMrPipelines: async () => [],
    getFailedJobs: async () => [],
    getJobLog: async () => '',
    retryPipeline: async () => {
      throw new Error('not used');
    },
    createMrNote: async () => ({ id: 1 }),
    createInlineComment: async () => ({ id: 1 }),
    listMrComments: async () => comments,
    replyToComment: async () => ({ id: 1 }),
    hasMergeConflicts: async () => false,
    isMrMerged: async () => false,
    enableAutoMerge: async () => {
      throw new Error('not used');
    },
    getCiConfigPath: async () => undefined,
  } as ForgeClient;
}

const SUPPORT_PAYLOAD = JSON.stringify({
  replies: [{ thread: 1, kind: 'support', severity: 'CRITICAL', reply: 'Confirmed — read it from the environment instead.' }],
});

test('replies to an open comment thread, on the thread it names, signed so a later run skips it', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const posted: Array<{ mrIid: number; commentId: string; body: string }> = [];
  try {
    const forge = forgeStub([mrComment()]);
    forge.replyToComment = async (mrIid, commentId, body) => {
      posted.push({ mrIid, commentId, body });
      return { id: posted.length };
    };
    const count = await maybeReplyToMrComments(forge, replyConfig(), agentReturning(SUPPORT_PAYLOAD), worktreePath, 'main', 7);

    assert.equal(count, 1);
    assert.equal(posted[0].mrIid, 7);
    assert.equal(posted[0].commentId, 'd1');
    assert.match(posted[0].body, /Confirmed — read it from the environment instead\./);
    assert.match(posted[0].body, /_CRITICAL · pipeline-worker reply \(claude\)_/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('the agent sees the scanner threads and the diff, read-only, in one turn', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const calls: AgentInvokeOptions[] = [];
  try {
    const comments = [
      mrComment({ id: 'issue:5', author: 'sonarqube[bot]', body: 'Remove this hard-coded credential.', path: undefined, line: undefined, threadable: false }),
      mrComment({ id: 'issue:6', author: 'checkmarx-one', body: 'CX SAST: hardcoded password.', path: undefined, line: undefined, threadable: false }),
    ];
    await maybeReplyToMrComments(forgeStub(comments), replyConfig(), agentReturning('{"replies":[]}', calls), worktreePath, 'main', 7);

    assert.equal(calls.length, 1, 'the whole discussion must be judged in one turn');
    assert.deepEqual(calls[0].allowedTools, ['Read']);
    assert.match(calls[0].systemPrompt ?? '', /Staff Software Engineer/);
    assert.match(calls[0].prompt, /### Thread 1 — @sonarqube\[bot\] \[SonarQube scanner\]/);
    assert.match(calls[0].prompt, /### Thread 2 — @checkmarx-one \[Checkmarx scanner\]/);
    assert.match(calls[0].prompt, /--- File: app\.ts/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test("pipeline-worker's own comments are never answered — a second review must not argue with itself", async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const own = mrComment({ body: '### Hard-coded secret\n\nMove it.\n\n_CRITICAL · pipeline-worker review (claude)_' });
    const count = await maybeReplyToMrComments(forgeStub([own]), replyConfig(), NEVER_INVOKED, worktreePath, 'main', 7);
    assert.equal(count, 0);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a MINOR agreement is dropped by the severity floor while a MINOR correction still lands', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const posted: string[] = [];
  try {
    const forge = forgeStub([mrComment({ id: 'a' }), mrComment({ id: 'b', author: 'bob', body: 'Move this to line 40 of utils.ts.' })]);
    forge.replyToComment = async (_mrIid, commentId, body) => {
      posted.push(`${commentId}:${body}`);
      return { id: posted.length };
    };
    const payload = JSON.stringify({
      replies: [
        { thread: 1, kind: 'support', severity: 'MINOR', reply: 'agreed, nit' },
        { thread: 2, kind: 'correct', severity: 'MINOR', reply: 'utils.ts is not on this branch.' },
      ],
    });
    const count = await maybeReplyToMrComments(forge, replyConfig(), agentReturning(payload), worktreePath, 'main', 7);

    assert.equal(count, 1);
    assert.match(posted[0], /^b:This is not recommended because: utils\.ts is not on this branch\./);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a forge that cannot list comments is reduced to a note, not a failed run', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const forge = forgeStub();
    forge.listMrComments = async () => {
      throw new Error('GitLab API GET discussions failed: 403 forbidden');
    };
    assert.equal(await maybeReplyToMrComments(forge, replyConfig(), NEVER_INVOKED, worktreePath, 'main', 7), 0);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a rejected reply costs only itself, and prose from the agent posts nothing', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const forge = forgeStub([mrComment({ id: 'a' }), mrComment({ id: 'b' })]);
    let call = 0;
    forge.replyToComment = async () => {
      call += 1;
      if (call === 1) throw new Error('thread is locked');
      return { id: call };
    };
    const payload = JSON.stringify({
      replies: [
        { thread: 1, kind: 'support', severity: 'CRITICAL', reply: 'one' },
        { thread: 2, kind: 'support', severity: 'MAJOR', reply: 'two' },
      ],
    });
    assert.equal(await maybeReplyToMrComments(forge, replyConfig(), agentReturning(payload), worktreePath, 'main', 7), 1);

    const quiet = forgeStub([mrComment()]);
    quiet.replyToComment = async () => {
      throw new Error('replyToComment must not be called');
    };
    assert.equal(await maybeReplyToMrComments(quiet, replyConfig(), agentReturning('Looks fine to me!'), worktreePath, 'main', 7), 0);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('an unreachable target branch is reduced to a note, after the comments were already fetched', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const count = await maybeReplyToMrComments(forgeStub([mrComment()]), replyConfig(), NEVER_INVOKED, worktreePath, 'no-such-branch', 7);
    assert.equal(count, 0);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});
