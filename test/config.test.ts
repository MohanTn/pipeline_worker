import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';

const execFileAsync = promisify(execFile);

/**
 * These tests assert on loadConfig's default/env-only resolution, which only
 * holds with a clean environment. A real .env (e.g. this repo's own, loaded
 * whenever pipeline-worker runs on itself) sets these for the whole process,
 * so isolate each test from whatever the ambient environment holds.
 */
const ENV_PREFIX = 'PIPELINE_WORKER_';
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-config-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Like withTempDir, but the dir is a real git repo with `origin` set to remoteUrl. */
async function withTempGitRepo(remoteUrl: string, fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-config-test-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig returns defaults in an empty repo', () => {
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

test('PIPELINE_WORKER_BUILD/LINT/TEST override detected defaults', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x', lint: 'y', test: 'z' } }));
    process.env.PIPELINE_WORKER_BUILD = 'make all';
    process.env.PIPELINE_WORKER_LINT = 'make lint';
    process.env.PIPELINE_WORKER_TEST = 'make test';
    const config = loadConfig(dir);
    assert.equal(config.build, 'make all');
    assert.equal(config.lint, 'make lint');
    assert.equal(config.test, 'make test');
  });
});

test('PIPELINE_WORKER_BUILD set to an empty string explicitly skips the stage, even with a detected default', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    process.env.PIPELINE_WORKER_BUILD = '';
    const config = loadConfig(dir);
    assert.equal(config.build, '');
  });
});

test('loadConfig falls back to defaults (and never throws) on missing repo info', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.agent, 'claude');
    assert.equal(config.maxFixAttempts, 5);
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

test('loadConfig defaults branchPattern to pipeline-worker/{name} and cleanupOnSuccess to true', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.branchPattern, 'pipeline-worker/{name}');
    assert.equal(config.cleanupOnSuccess, true);
  });
});

test('env vars set branchPattern and cleanupOnSuccess', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_BRANCH_PATTERN = '{type}/{name}';
    process.env.PIPELINE_WORKER_CLEANUP = 'false';
    const config = loadConfig(dir);
    assert.equal(config.branchPattern, '{type}/{name}');
    assert.equal(config.cleanupOnSuccess, false);
  });
});

test('loadConfig defaults intentModel to haiku', () => {
  withTempDir((dir) => {
    assert.equal(loadConfig(dir).intentModel, 'haiku');
  });
});

test('loadConfig defaults runLintAndTest to true', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.runLintAndTest, true);
  });
});

test('PIPELINE_WORKER_RUN_LINT_AND_TEST overrides the default', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_RUN_LINT_AND_TEST = 'false';
    assert.equal(loadConfig(dir).runLintAndTest, false);
  });
});

test('PIPELINE_WORKER_INTENT_MODEL overrides the default', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_INTENT_MODEL = 'sonnet';
    assert.equal(loadConfig(dir).intentModel, 'sonnet');
  });
});

test('PIPELINE_WORKER_MAX_FIX_ATTEMPTS overrides the default, and an invalid value falls back to it', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_MAX_FIX_ATTEMPTS = '2';
    assert.equal(loadConfig(dir).maxFixAttempts, 2);

    process.env.PIPELINE_WORKER_MAX_FIX_ATTEMPTS = 'not-a-number';
    assert.equal(loadConfig(dir).maxFixAttempts, 5);
  });
});

test('env vars set forge, github.repo, and pollIntervalSeconds', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_FORGE = 'github';
    process.env.PIPELINE_WORKER_GITHUB_REPO = 'acme/widgets';
    process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS = '60';
    const config = loadConfig(dir);
    assert.equal(config.forge, 'github');
    assert.equal(config.github.repo, 'acme/widgets');
    assert.equal(config.pollIntervalSeconds, 60);
  });
});

test('env vars set github.repo and gitlab.host/projectId', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_GITHUB_REPO = 'env-owner/env-repo';
    process.env.PIPELINE_WORKER_GITLAB_HOST = 'https://env.example.com';
    process.env.PIPELINE_WORKER_GITLAB_PROJECT_ID = '99';
    const config = loadConfig(dir);
    assert.equal(config.github.repo, 'env-owner/env-repo');
    assert.equal(config.gitlab.host, 'https://env.example.com');
    assert.equal(config.gitlab.projectId, 99);
  });
});

test('env vars set agent, forge, and poll interval', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_AGENT = 'copilot';
    process.env.PIPELINE_WORKER_FORGE = 'github';
    process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS = '60';
    const config = loadConfig(dir);
    assert.equal(config.agent, 'copilot');
    assert.equal(config.forge, 'github');
    assert.equal(config.pollIntervalSeconds, 60);
  });
});

test('invalid agent/forge/poll values fall back to defaults instead of throwing', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_AGENT = 'gpt';
    process.env.PIPELINE_WORKER_FORGE = 'bitbucket';
    process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS = '-3';
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
    const config = loadConfig(dir);
    assert.equal(config.forge, 'github'); // came from .env
    assert.equal(config.pollIntervalSeconds, 30);
  });
});

test('loadConfig accepts a non-numeric (namespace path) projectId from the env var', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_GITLAB_HOST = 'https://gitlab.example.com';
    process.env.PIPELINE_WORKER_GITLAB_PROJECT_ID = 'my-group/my-project';
    const config = loadConfig(dir);
    assert.equal(config.gitlab.projectId, 'my-group/my-project');
  });
});

test('loadConfig auto-detects project path via PIPELINE_WORKER_GITLAB_REPO_BASE', () => {
  withTempDir((dir) => {
    // Simulate: repoBase = dir, repoRoot = dir/Media/RetailMediaPortal
    const repoRoot = join(dir, 'Media', 'RetailMediaPortal');
    process.env.PIPELINE_WORKER_GITLAB_REPO_BASE = dir;
    const config = loadConfig(repoRoot);
    assert.equal(config.gitlab.projectId, 'media/retail-media-portal');
    assert.equal(config.gitlab.repoBase, dir);
  });
});

test('loadConfig: explicit PIPELINE_WORKER_GITLAB_PROJECT_ID takes precedence over repoBase auto-detection', () => {
  withTempDir((dir) => {
    const repoRoot = join(dir, 'Media', 'SomeProject');
    mkdirSync(repoRoot, { recursive: true });
    process.env.PIPELINE_WORKER_GITLAB_HOST = 'https://gitlab.example.com';
    process.env.PIPELINE_WORKER_GITLAB_PROJECT_ID = '42';
    process.env.PIPELINE_WORKER_GITLAB_REPO_BASE = dir;
    const config = loadConfig(repoRoot);
    assert.equal(config.gitlab.projectId, 42);
  });
});

test('loadConfig auto-detects github.repo from the origin remote when unset elsewhere', async () => {
  await withTempGitRepo('https://github.com/acme/widgets.git', async (dir) => {
    const config = loadConfig(dir);
    assert.equal(config.github.repo, 'acme/widgets');
  });
});

test('loadConfig: PIPELINE_WORKER_GITHUB_REPO takes precedence over origin-remote auto-detection', async () => {
  await withTempGitRepo('https://github.com/acme/widgets.git', async (dir) => {
    process.env.PIPELINE_WORKER_GITHUB_REPO = 'env-owner/env-repo';
    const config = loadConfig(dir);
    assert.equal(config.github.repo, 'env-owner/env-repo');
  });
});
