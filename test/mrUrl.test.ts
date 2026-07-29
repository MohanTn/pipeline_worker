/**
 * resolveMrUrl: the recorded URL always wins; older state files (mrIid only)
 * are rebuilt from the settings file, and anything that cannot produce a real
 * link stays undefined rather than guessing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMrUrl } from '../src/ui/mrUrl.js';
import type { PipelineWorkerConfig } from '../src/types.js';

function config(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
  return {
    forge: 'github',
    gitlab: { host: 'https://gitlab.com', projectId: 'group/app', token: '' },
    github: { repo: 'acme/app', token: '', apiUrl: 'https://api.github.com' },
    ...overrides,
  } as PipelineWorkerConfig;
}

test('the recorded url wins over anything rebuilt from settings', () => {
  const url = resolveMrUrl({ mrIid: 7, mrUrl: 'https://self-hosted.example/g/app/-/merge_requests/7' }, config());
  assert.equal(url, 'https://self-hosted.example/g/app/-/merge_requests/7');
});

test('a run with no mr/pr has no url, even with settings in hand', () => {
  assert.equal(resolveMrUrl({}, config()), undefined);
});

test('an older github run is rebuilt from the repo slug', () => {
  assert.equal(resolveMrUrl({ mrIid: 42 }, config()), 'https://github.com/acme/app/pull/42');
});

test('a github enterprise api url rebuilds against its own host, not github.com', () => {
  const ghe = config({ github: { repo: 'acme/app', token: '', apiUrl: 'https://ghe.example.com/api/v3' } });
  assert.equal(resolveMrUrl({ mrIid: 42 }, ghe), 'https://ghe.example.com/acme/app/pull/42');
});

test('an older gitlab run is rebuilt from the project path', () => {
  const gitlab = config({ forge: 'gitlab' });
  assert.equal(resolveMrUrl({ mrIid: 3 }, gitlab), 'https://gitlab.com/group/app/-/merge_requests/3');
});

test('a gitlab host with no scheme still produces an absolute url', () => {
  const gitlab = config({ forge: 'gitlab', gitlab: { host: 'gitlab.internal', projectId: 'group/app', token: '' } });
  assert.equal(resolveMrUrl({ mrIid: 3 }, gitlab), 'https://gitlab.internal/group/app/-/merge_requests/3');
});

test('a numeric gitlab project id names no web path, so no link is invented', () => {
  const gitlab = config({ forge: 'gitlab', gitlab: { host: 'https://gitlab.com', projectId: 1234, token: '' } });
  assert.equal(resolveMrUrl({ mrIid: 3 }, gitlab), undefined);
});

test('an unconfigured github repo yields no link', () => {
  const bare = config({ github: { repo: '', token: '', apiUrl: 'https://api.github.com' } });
  assert.equal(resolveMrUrl({ mrIid: 3 }, bare), undefined);
});

test('without settings, only a recorded url is available', () => {
  assert.equal(resolveMrUrl({ mrIid: 3 }), undefined);
  assert.equal(resolveMrUrl({ mrIid: 3, mrUrl: 'https://x/pull/3' }), 'https://x/pull/3');
});
