import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixMrComments } from '../src/workflow/fixMrComments.js';
import type { AgentAdapter, AgentInvokeOptions } from '../src/agent/types.js';
import type { ForgeClient, MrComment } from '../src/forge/types.js';
import type { PipelineWorkerConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);

const BRANCH = 'feature/reviewed';

function fixConfig(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
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
    reviewApprove: true,
    littleCoder: { binary: 'little-coder', maxPromptChars: 12_000 },
    ...overrides,
  } as PipelineWorkerConfig;
}

/** A feature branch that exists on its (bare) origin — so a fix has somewhere to push and the test can see whether it did. */
async function makeCommentedBranch(): Promise<{ worktreePath: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-fix-origin-'));
  const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-fix-repo-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: worktreePath });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: worktreePath });
  writeFileSync(join(worktreePath, 'base.txt'), 'base\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: worktreePath });
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: worktreePath });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: worktreePath });
  await execFileAsync('git', ['checkout', '-q', '-b', BRANCH], { cwd: worktreePath });
  writeFileSync(join(worktreePath, 'app.ts'), 'const token = "hunter2";\nexport const port = 8080;\n');
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'feat: add app'], { cwd: worktreePath });
  await execFileAsync('git', ['push', '-q', '-u', 'origin', BRANCH], { cwd: worktreePath });
  return { worktreePath, originDir };
}

async function originHead(originDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', `refs/heads/${BRANCH}`], { cwd: originDir });
  return stdout.trim();
}

/** An agent that edits the worktree exactly as a real fix turn would, then answers with `text`. */
function agentFixing(worktreePath: string, text: string, calls: AgentInvokeOptions[] = []): AgentAdapter {
  return {
    invoke: async (opts) => {
      calls.push(opts);
      writeFileSync(join(worktreePath, 'app.ts'), 'const token = process.env.TOKEN;\nexport const port = 8080;\n');
      return { text };
    },
  };
}

/** An agent that only talks — no file is touched. */
function agentSaying(text: string, calls: AgentInvokeOptions[] = []): AgentAdapter {
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
    approveMr: async () => {},
    getCiConfigPath: async () => undefined,
  } as ForgeClient;
}

const FIXED_PAYLOAD = JSON.stringify({
  fixes: [{ thread: 1, action: 'fixed', severity: 'CRITICAL', message: 'app.ts now reads the token from the environment.' }],
});

test('a valid comment is fixed, verified, pushed as one commit, and answered with that commit', async () => {
  const { worktreePath, originDir } = await makeCommentedBranch();
  const posted: Array<{ commentId: string; body: string }> = [];
  try {
    const before = await originHead(originDir);
    const forge = forgeStub([mrComment()]);
    forge.replyToComment = async (_mrIid, commentId, body) => {
      posted.push({ commentId, body });
      return { id: posted.length };
    };
    const outcome = await fixMrComments(forge, fixConfig(), agentFixing(worktreePath, FIXED_PAYLOAD), worktreePath, BRANCH, 'main', 7);

    assert.equal(outcome.fixed, 1);
    assert.equal(outcome.refuted, 0);
    assert.equal(outcome.posted, 1);
    assert.notEqual(await originHead(originDir), before, 'the fix must be pushed onto the branch');
    const { stdout: subject } = await execFileAsync('git', ['log', '-1', '--pretty=%s', `refs/heads/${BRANCH}`], { cwd: originDir });
    assert.match(subject.trim(), /^fix: address 1 review comment\(s\) on !7$/);
    assert.equal(posted[0].commentId, 'd1');
    assert.match(posted[0].body, new RegExp(`^Fixed in \`${outcome.sha}\`: app\\.ts now reads the token`));
    assert.match(posted[0].body, /_CRITICAL · pipeline-worker fix \(claude\)_/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('an invalid comment changes no code and is answered with the reason', async () => {
  const { worktreePath, originDir } = await makeCommentedBranch();
  const posted: string[] = [];
  try {
    const before = await originHead(originDir);
    const forge = forgeStub([mrComment({ author: 'sonarqube[bot]', body: 'Remove this unused import.' })]);
    forge.replyToComment = async (_mrIid, _commentId, body) => {
      posted.push(body);
      return { id: posted.length };
    };
    const payload = JSON.stringify({ fixes: [{ thread: 1, action: 'invalid', severity: 'MINOR', message: 'app.ts has no imports at all.' }] });
    const outcome = await fixMrComments(forge, fixConfig(), agentSaying(payload), worktreePath, BRANCH, 'main', 7);

    assert.deepEqual(outcome, { fixed: 0, refuted: 1, posted: 1 });
    assert.equal(await originHead(originDir), before, 'a refuted comment must push nothing');
    assert.match(posted[0], /^This is not recommended because: app\.ts has no imports at all\./);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a "fixed" claim with an untouched worktree is dropped, not posted', async () => {
  const { worktreePath, originDir } = await makeCommentedBranch();
  try {
    const before = await originHead(originDir);
    const forge = forgeStub([mrComment()]);
    forge.replyToComment = async () => {
      throw new Error('replyToComment must not be called');
    };
    const outcome = await fixMrComments(forge, fixConfig(), agentSaying(FIXED_PAYLOAD), worktreePath, BRANCH, 'main', 7);

    assert.deepEqual(outcome, { fixed: 0, refuted: 0, posted: 0 });
    assert.equal(await originHead(originDir), before);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a failing check aborts before the push, so a broken fix never reaches the branch', async () => {
  const { worktreePath, originDir } = await makeCommentedBranch();
  try {
    const before = await originHead(originDir);
    const forge = forgeStub([mrComment()]);
    forge.replyToComment = async () => {
      throw new Error('replyToComment must not be called');
    };
    const config = fixConfig({ build: 'node -e "process.exit(1)"' });
    await assert.rejects(
      () => fixMrComments(forge, config, agentFixing(worktreePath, FIXED_PAYLOAD), worktreePath, BRANCH, 'main', 7),
      /build fails after the comment fixes — nothing pushed/,
    );
    assert.equal(await originHead(originDir), before);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test("pipeline-worker's own threads are never acted on — a second fix run must not argue with itself", async () => {
  const { worktreePath, originDir } = await makeCommentedBranch();
  try {
    const own = mrComment({ body: 'Fixed in `a1b2c3d`: reads it from env now.\n\n_MAJOR · pipeline-worker fix (claude)_' });
    const outcome = await fixMrComments(forgeStub([own]), fixConfig(), NEVER_INVOKED, worktreePath, BRANCH, 'main', 7);
    assert.deepEqual(outcome, { fixed: 0, refuted: 0, posted: 0 });
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('the agent sees every thread plus the diff, and gets write access to the worktree', async () => {
  const { worktreePath, originDir } = await makeCommentedBranch();
  const calls: AgentInvokeOptions[] = [];
  try {
    const comments = [
      mrComment({ id: 'a', author: 'coderabbitai[bot]', body: 'Prefer an env var here.' }),
      mrComment({ id: 'b', author: 'checkmarx-one', body: 'CX SAST: hardcoded password.', path: undefined, line: undefined, threadable: false }),
    ];
    await fixMrComments(forgeStub(comments), fixConfig(), agentSaying('{"fixes":[]}', calls), worktreePath, BRANCH, 'main', 7);

    assert.equal(calls.length, 1, 'the whole discussion must be judged in one turn');
    assert.equal(calls[0].permissionMode, 'acceptEdits');
    assert.equal(calls[0].allowedTools, undefined, 'a fix turn needs the project\'s own commands, not a read-only tool list');
    assert.equal(calls[0].cwd, worktreePath);
    assert.match(calls[0].prompt, /### Thread 1 — @coderabbitai\[bot\] \[CodeRabbit scanner\]/);
    assert.match(calls[0].prompt, /### Thread 2 — @checkmarx-one \[Checkmarx scanner\]/);
    assert.match(calls[0].prompt, /--- File: app\.ts/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a forge that cannot list comments fails the command rather than reporting success', async () => {
  const { worktreePath, originDir } = await makeCommentedBranch();
  try {
    const forge = forgeStub();
    forge.listMrComments = async () => {
      throw new Error('GitLab API GET discussions failed: 403 forbidden');
    };
    await assert.rejects(() => fixMrComments(forge, fixConfig(), NEVER_INVOKED, worktreePath, BRANCH, 'main', 7), /403 forbidden/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});
