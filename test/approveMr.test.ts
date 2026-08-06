import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeApproveMergeRequest } from '../src/workflow/approveMr.js';
import type { ForgeClient } from '../src/forge/types.js';
import type { PipelineWorkerConfig } from '../src/types.js';

function approveConfig(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
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
    switchToFeatureBranch: false,
    plainOutput: true,
    ...overrides,
  } as PipelineWorkerConfig;
}

/** Records what the approval stage asked the forge for; everything else throws so an unexpected call is loud. */
function forgeStub(overrides: Partial<ForgeClient> = {}): { forge: ForgeClient; approved: number[] } {
  const approved: number[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error('not used');
  };
  const forge = {
    findExistingMr: notUsed,
    createMergeRequest: notUsed,
    updateMrDescription: notUsed,
    getMrDescription: notUsed,
    getMrPipelines: notUsed,
    getFailedJobs: notUsed,
    getJobLog: notUsed,
    retryPipeline: notUsed,
    createMrNote: notUsed,
    createInlineComment: notUsed,
    listMrComments: notUsed,
    replyToComment: notUsed,
    hasMergeConflicts: async () => false,
    isMrMerged: notUsed,
    enableAutoMerge: notUsed,
    approveMr: async (mrIid: number) => {
      approved.push(mrIid);
    },
    getCiConfigPath: notUsed,
    ...overrides,
  } as unknown as ForgeClient;
  return { forge, approved };
}

test('approves the MR/PR the review vouched for, once, on the right iid', async () => {
  const { forge, approved } = forgeStub();
  assert.equal(await maybeApproveMergeRequest(forge, approveConfig(), 7, true), true);
  assert.deepEqual(approved, [7]);
});

// The whole point of the clean flag: a review that flagged something, failed,
// or never ran must not end in an approval.
test('does not approve — and does not touch the forge — when the review was not clean', async () => {
  const { forge, approved } = forgeStub({
    hasMergeConflicts: async () => {
      throw new Error('hasMergeConflicts must not be called');
    },
  });
  assert.equal(await maybeApproveMergeRequest(forge, approveConfig(), 7, false), false);
  assert.deepEqual(approved, []);
});

test('does not approve when reviewApprove is disabled, even on a clean review', async () => {
  const { forge, approved } = forgeStub();
  assert.equal(await maybeApproveMergeRequest(forge, approveConfig({ reviewApprove: false }), 7, true), false);
  assert.deepEqual(approved, []);
});

test('does not approve a clean review that cannot merge — conflicts are nobody\'s to approve past', async () => {
  const { forge, approved } = forgeStub({ hasMergeConflicts: async () => true });
  assert.equal(await maybeApproveMergeRequest(forge, approveConfig(), 7, true), false);
  assert.deepEqual(approved, []);
});

test('a forge refusing the approval (self-approval, paid-tier API) is reduced to a note, not a failed run', async () => {
  const { forge } = forgeStub({
    approveMr: async () => {
      throw new Error('GitHub API POST /pulls/7/reviews failed: 422 Can not approve your own pull request');
    },
  });
  assert.equal(await maybeApproveMergeRequest(forge, approveConfig(), 7, true), false);
});

test('a forge that cannot answer the conflict check is reduced to a note, and approves nothing', async () => {
  const { forge, approved } = forgeStub({
    hasMergeConflicts: async () => {
      throw new Error('GitLab API GET merge_requests/7 failed: 403 forbidden');
    },
  });
  assert.equal(await maybeApproveMergeRequest(forge, approveConfig(), 7, true), false);
  assert.deepEqual(approved, []);
});
