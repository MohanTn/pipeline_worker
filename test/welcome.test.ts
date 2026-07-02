import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositoryUrl, agentDescription } from '../src/ui/welcome.js';
import type { PipelineWorkerConfig } from '../src/types.js';

function baseConfig(overrides: Partial<PipelineWorkerConfig> = {}): PipelineWorkerConfig {
  return {
    agent: 'claude',
    forge: 'github',
    gitlab: { host: '', projectId: 0 },
    github: { repo: '' },
    build: '',
    lint: '',
    test: '',
    maxFixAttempts: 5,
    pollIntervalSeconds: 15,
    ...overrides,
  };
}

test('repositoryUrl builds a GitHub URL from owner/repo', () => {
  assert.equal(repositoryUrl(baseConfig({ forge: 'github', github: { repo: 'MohanTn/pipeline_worker' } })), 'https://github.com/MohanTn/pipeline_worker');
});

test('repositoryUrl shows the GitLab host and project id', () => {
  assert.equal(
    repositoryUrl(baseConfig({ forge: 'gitlab', gitlab: { host: 'https://gitlab.example.com', projectId: 42 } })),
    'https://gitlab.example.com (project 42)',
  );
});

test('repositoryUrl reports unconfigured repos plainly instead of an empty/broken URL', () => {
  assert.equal(repositoryUrl(baseConfig({ forge: 'github', github: { repo: '' } })), '(not configured)');
  assert.equal(repositoryUrl(baseConfig({ forge: 'gitlab', gitlab: { host: '', projectId: 0 } })), '(not configured)');
});

test('agentDescription notes the lighter model claude uses for intent capture', () => {
  assert.match(agentDescription(baseConfig({ agent: 'claude' })), /haiku/);
});

test('agentDescription is plain for copilot, which has no per-invocation model selection', () => {
  assert.equal(agentDescription(baseConfig({ agent: 'copilot' })), 'copilot');
});
