import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { maybeReviewMergeRequest, postFindings, reviewTurnLimits, scopeChunks } from '../src/workflow/reviewMr.js';
import type { AgentAdapter, AgentInvokeOptions } from '../src/agent/types.js';
import type { ForgeClient, InlineComment } from '../src/forge/types.js';
import type { DiffChunk } from '../src/review/types.js';
import type { PipelineWorkerConfig } from '../src/types.js';

const execFileAsync = promisify(execFile);

function reviewConfig(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
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
  };
}

/** A repo whose feature branch adds one file on top of origin/main — the shape the review stage diffs. */
async function makeReviewableBranch(): Promise<{ worktreePath: string; originDir: string }> {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-review-origin-'));
  const worktreePath = mkdtempSync(join(tmpdir(), 'pipeline-worker-review-repo-'));
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

/** Adds `count` files on the feature branch, so grouping has something to group. */
async function addFiles(worktreePath: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) writeFileSync(join(worktreePath, `mod${i}.ts`), `export const v${i} = ${i};\n`);
  await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-q', '-m', 'feat: more files'], { cwd: worktreePath });
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

/** A forge that answers everything harmlessly; each test overwrites the one method it cares about. */
function forgeStub(): ForgeClient {
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
    hasMergeConflicts: async () => false,
    isMrMerged: async () => false,
    enableAutoMerge: async () => {
      throw new Error('not used');
    },
    approveMr: async () => {},
    getCiConfigPath: async () => undefined,
  };
}

const CRITICAL_FINDING = JSON.stringify({
  findings: [{ file: 'app.ts', line: 1, severity: 'CRITICAL', comment: '### Hard-coded secret\n\nMove it to an env var.\n```suggestion\nconst token = process.env.TOKEN;\n```' }],
});

test('does not invoke the agent or the forge when config.review is disabled', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const outcome = await maybeReviewMergeRequest(forgeStub(), reviewConfig({ review: false }), NEVER_INVOKED, worktreePath, 'main', 7);
    assert.deepEqual(outcome, { posted: 0, clean: false }, 'a skipped review must never read as a clean one');
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('posts one inline comment per surviving finding, on the right file and line, with the forge-specific suggestion fence', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const comments: Array<{ mrIid: number; comment: InlineComment }> = [];
  try {
    const forge = forgeStub();
    forge.createInlineComment = async (mrIid, comment) => {
      comments.push({ mrIid, comment });
      return { id: comments.length };
    };
    const outcome = await maybeReviewMergeRequest(forge, reviewConfig(), agentReturning(CRITICAL_FINDING), worktreePath, 'main', 7);

    assert.deepEqual(outcome, { posted: 1, clean: false });
    assert.equal(comments.length, 1);
    assert.equal(comments[0].mrIid, 7);
    assert.equal(comments[0].comment.path, 'app.ts');
    assert.equal(comments[0].comment.line, 1);
    assert.match(comments[0].comment.body, /```suggestion:-0\+0\nconst token = process\.env\.TOKEN;/);
    assert.match(comments[0].comment.body, /CRITICAL · pipeline-worker review \(claude\)/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('passes the review model through only when one is configured, with reading files as the only tool', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const calls: AgentInvokeOptions[] = [];
  try {
    await maybeReviewMergeRequest(forgeStub(), reviewConfig(), agentReturning('[]', calls), worktreePath, 'main', 7);
    assert.equal(calls[0].model, undefined);
    assert.deepEqual(calls[0].allowedTools, ['Read']);
    // The persona is the turn's system prompt now, not a prefix repeated in
    // every chunk's prompt — and the chunk is told not to read the file back.
    assert.match(calls[0].systemPrompt ?? '', /Staff Software Engineer/);
    assert.doesNotMatch(calls[0].prompt, /Staff Software Engineer/);
    assert.match(calls[0].prompt, /Do not open the changed files/);
    assert.match(calls[0].prompt, /File: app\.ts/);

    calls.length = 0;
    await maybeReviewMergeRequest(forgeStub(), reviewConfig({ reviewModel: 'sonnet' }), agentReturning('[]', calls), worktreePath, 'main', 7);
    assert.equal(calls[0].model, 'sonnet');
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a cloud agent reviews every file of a multi-file diff in ONE session, each as its own labeled section', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const calls: AgentInvokeOptions[] = [];
  try {
    await addFiles(worktreePath, 5);
    await maybeReviewMergeRequest(forgeStub(), reviewConfig(), agentReturning('[]', calls), worktreePath, 'main', 7);

    assert.equal(calls.length, 1, `expected one agent turn for the whole diff, got ${calls.length}`);
    for (const path of ['app.ts', 'mod0.ts', 'mod4.ts']) {
      assert.match(calls[0].prompt, new RegExp(`--- File: ${path.replace('.', '\\.')}`), `${path} missing from the single turn`);
    }
    assert.match(calls[0].prompt, /Files in this diff, all of which you must review:/);
    assert.match(calls[0].prompt, /"file" to the path in the "--- File:" header/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('little-coder gets the same diff as several small turns instead', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const calls: AgentInvokeOptions[] = [];
  try {
    await addFiles(worktreePath, 5);
    const config = reviewConfig({ agent: 'little-coder' });
    await maybeReviewMergeRequest(forgeStub(), config, agentReturning('[]', calls), worktreePath, 'main', 7);

    // 6 files at 3 per turn.
    assert.equal(calls.length, 2, `expected the diff sliced into 2 turns, got ${calls.length}`);
    for (const call of calls) assert.ok(call.prompt.length <= reviewTurnLimits(config).maxChars + 2_000, 'a local turn must stay near its prompt cap');
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a finding is anchored to the right file when one turn carried several', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  const comments: Array<{ mrIid: number; comment: InlineComment }> = [];
  try {
    await addFiles(worktreePath, 2);
    const forge = forgeStub();
    forge.createInlineComment = async (mrIid, comment) => {
      comments.push({ mrIid, comment });
      return { id: comments.length };
    };
    const payload = JSON.stringify({
      findings: [
        { file: 'mod1.ts', line: 1, severity: 'CRITICAL', comment: '### Bad\n\nno' },
        { file: 'app.ts', line: 2, severity: 'MAJOR', comment: '### Also bad\n\nno' },
        // A line that exists in mod1.ts but not in app.ts must not be salvaged onto the wrong file.
        { file: 'app.ts', line: 99, severity: 'CRITICAL', comment: '### Hallucinated\n\nno' },
      ],
    });
    const outcome = await maybeReviewMergeRequest(forge, reviewConfig(), agentReturning(payload), worktreePath, 'main', 7);

    assert.equal(outcome.posted, 2);
    assert.deepEqual(
      comments.map((entry) => `${entry.comment.path}:${entry.comment.line}`).sort(),
      ['app.ts:2', 'mod1.ts:1'],
    );
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('an unusable agent payload leaves the run unchanged and posts nothing', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const forge = forgeStub();
    forge.createInlineComment = async () => {
      throw new Error('createInlineComment must not be called');
    };
    const outcome = await maybeReviewMergeRequest(forge, reviewConfig(), agentReturning('Looks fine to me!'), worktreePath, 'main', 7);
    assert.deepEqual(outcome, { posted: 0, clean: true }, 'prose parses to no findings, which is a clean diff');
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('a forge rejecting the comment position is reduced to a note, not an exception', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const forge = forgeStub();
    forge.createInlineComment = async () => {
      throw new Error('GitLab API POST discussions failed: 400 line must be part of the diff');
    };
    const outcome = await maybeReviewMergeRequest(forge, reviewConfig(), agentReturning(CRITICAL_FINDING), worktreePath, 'main', 7);
    assert.deepEqual(outcome, { posted: 0, clean: false }, 'a finding that could not be posted is still a finding');
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('an unreachable target branch (no such ref) is reduced to a note, not a failed run', async () => {
  const { worktreePath, originDir } = await makeReviewableBranch();
  try {
    const outcome = await maybeReviewMergeRequest(forgeStub(), reviewConfig(), NEVER_INVOKED, worktreePath, 'no-such-branch', 7);
    assert.deepEqual(outcome, { posted: 0, clean: false }, 'a failed review must never read as a clean one');
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
});

test('reviewTurnLimits gives a cloud agent the whole diff in one turn', () => {
  const limits = reviewTurnLimits(reviewConfig());
  assert.equal(limits.maxFiles, 0, '0 = no file cap, so the whole diff groups into one turn');
  assert.equal(limits.maxChars, 200_000);
});

test('reviewTurnLimits ignores the littleCoder section entirely for a cloud agent', () => {
  const limits = reviewTurnLimits(reviewConfig({ littleCoder: { binary: 'little-coder', maxPromptChars: 500 } }));
  assert.equal(limits.maxChars, 200_000);
  assert.equal(limits.maxFiles, 0);
});

test('reviewTurnLimits slices for little-coder, clamped under its prompt cap so the adapter never trims mid-diff', () => {
  const limits = reviewTurnLimits(reviewConfig({ agent: 'little-coder' }));
  assert.equal(limits.maxFiles, 3);
  assert.equal(limits.maxChars, 12_000 - 1_500, 'the prompt overhead is held back from the diff budget');
});

test('reviewTurnLimits keeps a local turn reviewable even when maxPromptChars is tiny', () => {
  const limits = reviewTurnLimits(reviewConfig({ agent: 'little-coder', littleCoder: { binary: 'little-coder', maxPromptChars: 1_000 } }));
  assert.equal(limits.maxChars, 2_000);
});

test('reviewTurnLimits lets an uncapped little-coder fall back to the configured char budget', () => {
  const limits = reviewTurnLimits(reviewConfig({ agent: 'little-coder', reviewChunkChars: 9_000, littleCoder: { binary: 'little-coder', maxPromptChars: 0 } }));
  assert.equal(limits.maxChars, 9_000);
  assert.equal(limits.maxFiles, 3);
});

test('an explicit reviewFilesPerTurn wins for both agents', () => {
  assert.equal(reviewTurnLimits(reviewConfig({ reviewFilesPerTurn: 5 })).maxFiles, 5);
  assert.equal(reviewTurnLimits(reviewConfig({ agent: 'little-coder', reviewFilesPerTurn: 1 })).maxFiles, 1);
});

test('scopeChunks narrows a follow-up run to the files that run touched', () => {
  const chunks: DiffChunk[] = [
    { path: 'app.ts', language: 'TypeScript', body: '', commentableLines: [1], commentableText: { 1: 'const a = 1;' } },
    { path: 'old.ts', language: 'TypeScript', body: '', commentableLines: [4], commentableText: { 4: 'const b = 2;' } },
  ];
  assert.deepEqual(scopeChunks(chunks, ['app.ts']).map((chunk) => chunk.path), ['app.ts']);
  assert.equal(scopeChunks(chunks, undefined).length, 2, 'a fresh run reviews the whole branch diff');
});

test('postFindings keeps going after a rejected comment and reports only what landed', async () => {
  const forge = forgeStub();
  let call = 0;
  forge.createInlineComment = async () => {
    call += 1;
    if (call === 1) throw new Error('outdated position');
    return { id: call };
  };
  const posted = await postFindings(
    forge,
    7,
    [
      { file: 'app.ts', line: 1, severity: 'CRITICAL', comment: 'a' },
      { file: 'app.ts', line: 2, severity: 'MAJOR', comment: 'b' },
    ],
    'github',
    'claude',
  );
  assert.equal(posted, 1);
});
