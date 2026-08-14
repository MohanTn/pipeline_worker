import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReviewRound } from '../src/workflow/runCommands.js';
import { appendReviewTurn } from '../src/state/reviewTurns.js';
import type { ForgeClient, MrComment } from '../src/forge/types.js';

function comment(id: string, body: string): MrComment {
  return { id, author: 'dev', body, path: 'app.ts', line: 1, threadable: true };
}

/** Only listMrComments is reached from here; everything else would be a bug in the round setup. */
function forgeWith(comments: MrComment[] | Error): ForgeClient {
  return {
    listMrComments: async () => {
      if (comments instanceof Error) throw comments;
      return comments;
    },
  } as unknown as ForgeClient;
}

function withRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'pipeline-worker-review-round-'));
  return fn(repoRoot).finally(() => rmSync(repoRoot, { recursive: true, force: true }));
}

test('a branch never reviewed starts at round 1 and carries no thread context', async () => {
  await withRepo(async (repoRoot) => {
    const { round, threadIds } = await prepareReviewRound(forgeWith([comment('t1', 'pre-existing thread')]), repoRoot, 'feat/login', 7);
    assert.equal(round.turn, 1);
    assert.deepEqual(round.newThreads, [], 'round 1 has nothing to react to — every thread predates the first review');
    assert.deepEqual(threadIds, ['t1'], 'but the baseline is recorded, so round 2 knows which threads are new');
  });
});

test('a later round carries only the threads opened since the last one', async () => {
  await withRepo(async (repoRoot) => {
    appendReviewTurn(repoRoot, 'feat/login', { turn: 1, at: '2026-01-01T00:00:00.000Z', posted: ['app.ts:1:aaaaaaaa'], ignored: [], edited: [], threadIds: ['t1'] });
    const { round, threadIds } = await prepareReviewRound(forgeWith([comment('t1', 'old thread'), comment('t2', 'this is intentional')]), repoRoot, 'feat/login', 7);

    assert.equal(round.turn, 2);
    assert.equal(round.newThreads.length, 1);
    assert.match(round.newThreads[0], /this is intentional/);
    assert.match(round.newThreads[0], /@dev on app\.ts:1/);
    assert.deepEqual(round.priorTurns.map((entry) => entry.turn), [1]);
    assert.deepEqual(threadIds, ['t1', 't2']);
  });
});

test('a forge that will not list comments costs the round its context, not its run', async () => {
  await withRepo(async (repoRoot) => {
    appendReviewTurn(repoRoot, 'main', { turn: 1, at: '2026-01-01T00:00:00.000Z', posted: [], ignored: [], edited: [], threadIds: ['t1'] });
    const { round, threadIds } = await prepareReviewRound(forgeWith(new Error('403 forbidden')), repoRoot, 'main', 7);
    assert.equal(round.turn, 2);
    assert.deepEqual(round.newThreads, []);
    assert.deepEqual(threadIds, []);
  });
});

test('no picker is wired up in a non-interactive process, so the review posts what it always did', async () => {
  await withRepo(async (repoRoot) => {
    const { round } = await prepareReviewRound(forgeWith([]), repoRoot, 'main', 7);
    assert.equal(round.selectFindings, undefined, 'node:test runs with no TTY on stdin');
  });
});
