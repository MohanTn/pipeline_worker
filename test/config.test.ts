import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-config-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig returns defaults when .pipeline-worker.yml is missing', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.agent, 'claude');
    assert.equal(config.maxFixAttempts, 5);
    assert.equal(config.build, ''); // no toolchain marker in an empty dir: checks are skipped
  });
});

test('loadConfig defaults build/lint/test from detected npm scripts', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x', test: 'y' } }));
    const config = loadConfig(dir);
    assert.equal(config.build, 'npm run build');
    assert.equal(config.lint, ''); // no lint script declared
    assert.equal(config.test, 'npm test');
  });
});

test('yaml check commands override detected defaults', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'build: make all\n');
    const config = loadConfig(dir);
    assert.equal(config.build, 'make all');
  });
});

test('loadConfig merges values from .pipeline-worker.yml over defaults', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, '.pipeline-worker.yml'),
      'agent: copilot\ngitlab:\n  host: https://gitlab.example.com\n  projectId: 99\nmaxFixAttempts: 2\n',
    );
    const config = loadConfig(dir);
    assert.equal(config.agent, 'copilot');
    assert.equal(config.gitlab.host, 'https://gitlab.example.com');
    assert.equal(config.gitlab.projectId, 99);
    assert.equal(config.maxFixAttempts, 2);
    assert.equal(config.lint, ''); // untouched fields keep their (detected) default
  });
});

test('loadConfig falls back to defaults (and never throws) on corrupt YAML', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'agent: [this is: not, valid: yaml');
    const config = loadConfig(dir);
    assert.equal(config.agent, 'claude');
    assert.equal(config.maxFixAttempts, 5);
  });
});

test('loadConfig honors an explicit override path', () => {
  withTempDir((dir) => {
    const altPath = join(dir, 'alt.yml');
    writeFileSync(altPath, 'agent: copilot\n');
    const config = loadConfig(dir, altPath);
    assert.equal(config.agent, 'copilot');
  });
});

test('loadConfig defaults forge to gitlab and pollIntervalSeconds to 15', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.forge, 'gitlab');
    assert.equal(config.pollIntervalSeconds, 15);
    assert.equal(config.github.repo, '');
  });
});

test('loadConfig reads forge, github.repo, and pollIntervalSeconds from yaml', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'forge: github\ngithub:\n  repo: acme/widgets\npollIntervalSeconds: 60\n');
    const config = loadConfig(dir);
    assert.equal(config.forge, 'github');
    assert.equal(config.github.repo, 'acme/widgets');
    assert.equal(config.pollIntervalSeconds, 60);
  });
});

test('env vars override yaml for agent, forge, and poll interval', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'agent: claude\nforge: gitlab\npollIntervalSeconds: 15\n');
    process.env.PIPELINE_WORKER_AGENT = 'copilot';
    process.env.PIPELINE_WORKER_FORGE = 'github';
    process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS = '60';
    try {
      const config = loadConfig(dir);
      assert.equal(config.agent, 'copilot');
      assert.equal(config.forge, 'github');
      assert.equal(config.pollIntervalSeconds, 60);
    } finally {
      delete process.env.PIPELINE_WORKER_AGENT;
      delete process.env.PIPELINE_WORKER_FORGE;
      delete process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS;
    }
  });
});

test('invalid agent/forge/poll values fall back to defaults instead of throwing', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'agent: gpt\nforge: bitbucket\npollIntervalSeconds: -3\n');
    const config = loadConfig(dir);
    assert.equal(config.agent, 'claude');
    assert.equal(config.forge, 'gitlab');
    assert.equal(config.pollIntervalSeconds, 15);
  });
});

test('.env at repo root supplies defaults but never overrides real env', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'PIPELINE_WORKER_FORGE=github\nPIPELINE_WORKER_POLL_INTERVAL_SECONDS=60\n');
    process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS = '30'; // real env wins over .env
    try {
      const config = loadConfig(dir);
      assert.equal(config.forge, 'github'); // came from .env
      assert.equal(config.pollIntervalSeconds, 30);
    } finally {
      delete process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS;
      delete process.env.PIPELINE_WORKER_FORGE; // loadDotEnv set it from the file
    }
  });
});

test('loadConfig honors PIPELINE_WORKER_CONFIG env var when no override param is given', () => {
  withTempDir((dir) => {
    const altPath = join(dir, 'env.yml');
    writeFileSync(altPath, 'maxFixAttempts: 1\n');
    process.env.PIPELINE_WORKER_CONFIG = altPath;
    try {
      const config = loadConfig(dir);
      assert.equal(config.maxFixAttempts, 1);
    } finally {
      delete process.env.PIPELINE_WORKER_CONFIG;
    }
  });
});
