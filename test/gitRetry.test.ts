import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableGitError, withGitRetry } from '../src/git/commit.js';

test('isRetryableGitError recognizes common transient network failures against a git remote', () => {
  assert.equal(isRetryableGitError("fatal: unable to access 'https://example.com/repo.git': Could not resolve host: example.com"), true);
  assert.equal(isRetryableGitError('ssh: connect to host example.com port 22: Connection refused'), true);
  assert.equal(isRetryableGitError('error: RPC failed; curl 56 GnuTLS recv error'), true);
  assert.equal(isRetryableGitError('fatal: early EOF'), true);
  assert.equal(isRetryableGitError('The requested URL returned error: 502'), true);
});

test('isRetryableGitError treats real rejections (conflicts, auth, rejected pushes) as non-retryable', () => {
  assert.equal(isRetryableGitError('CONFLICT (content): Merge conflict in foo.ts'), false);
  assert.equal(isRetryableGitError('fatal: Authentication failed for https://example.com/repo.git'), false);
  assert.equal(isRetryableGitError('! [rejected] feat/x -> feat/x (non-fast-forward)'), false);
  assert.equal(isRetryableGitError('nothing to commit, working tree clean'), false);
});

test('withGitRetry retries a retryable error until it succeeds, then stops retrying', async () => {
  let attempts = 0;
  const result = await withGitRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('Could not resolve host: example.com');
      return 'ok';
    },
    { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2 },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('withGitRetry gives up and rethrows once a retryable error exhausts maxRetries', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withGitRetry(
        async () => {
          attempts += 1;
          throw new Error('Connection timed out');
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    /Connection timed out/,
  );
  assert.equal(attempts, 3, 'the initial attempt plus 2 retries');
});

test('withGitRetry never retries a non-retryable error, even on the first attempt', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withGitRetry(
        async () => {
          attempts += 1;
          throw new Error('fatal: Authentication failed');
        },
        { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    /Authentication failed/,
  );
  assert.equal(attempts, 1);
});
