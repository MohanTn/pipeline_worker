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
 * These tests assert on loadConfig's default/yaml-only resolution, which
 * only holds with a clean environment. A real .env (e.g. this repo's own,
 * loaded whenever pipeline-worker runs on itself) sets these for the whole
 * process, so isolate each test from whatever the ambient environment holds.
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

test('loadConfig defaults branchPattern to pipeline-worker/{name} and cleanupOnSuccess to true', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.branchPattern, 'pipeline-worker/{name}');
    assert.equal(config.cleanupOnSuccess, true);
  });
});

test('loadConfig reads branchPattern and cleanupOnSuccess from yaml', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'branchPattern: "{type}/{ticket}/{name}"\ncleanupOnSuccess: false\n');
    const config = loadConfig(dir);
    assert.equal(config.branchPattern, '{type}/{ticket}/{name}');
    assert.equal(config.cleanupOnSuccess, false);
  });
});

test('env vars override yaml for branchPattern and cleanupOnSuccess', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'branchPattern: "yaml/{name}"\ncleanupOnSuccess: true\n');
    process.env.PIPELINE_WORKER_BRANCH_PATTERN = '{type}/{name}';
    process.env.PIPELINE_WORKER_CLEANUP = 'false';
    const config = loadConfig(dir);
    assert.equal(config.branchPattern, '{type}/{name}');
    assert.equal(config.cleanupOnSuccess, false);
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

test('env vars override yaml for github.repo and gitlab.host/projectId', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, '.pipeline-worker.yml'),
      'github:\n  repo: yaml-owner/yaml-repo\ngitlab:\n  host: https://yaml.example.com\n  projectId: 1\n',
    );
    process.env.PIPELINE_WORKER_GITHUB_REPO = 'env-owner/env-repo';
    process.env.PIPELINE_WORKER_GITLAB_HOST = 'https://env.example.com';
    process.env.PIPELINE_WORKER_GITLAB_PROJECT_ID = '99';
    const config = loadConfig(dir);
    assert.equal(config.github.repo, 'env-owner/env-repo');
    assert.equal(config.gitlab.host, 'https://env.example.com');
    assert.equal(config.gitlab.projectId, 99);
  });
});

test('env vars override yaml for agent, forge, and poll interval', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'agent: claude\nforge: gitlab\npollIntervalSeconds: 15\n');
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
    const config = loadConfig(dir);
    assert.equal(config.forge, 'github'); // came from .env
    assert.equal(config.pollIntervalSeconds, 30);
  });
});

test('loadConfig honors PIPELINE_WORKER_CONFIG env var when no override param is given', () => {
  withTempDir((dir) => {
    const altPath = join(dir, 'env.yml');
    writeFileSync(altPath, 'maxFixAttempts: 1\n');
    process.env.PIPELINE_WORKER_CONFIG = altPath;
    const config = loadConfig(dir);
    assert.equal(config.maxFixAttempts, 1);
  });
});

test('loadConfig accepts a string projectId from YAML', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, '.pipeline-worker.yml'),
      'gitlab:\n  host: https://gitlab.example.com\n  projectId: "my-group/my-project"\n',
    );
    const config = loadConfig(dir);
    assert.equal(config.gitlab.projectId, 'my-group/my-project');
  });
});

test('loadConfig auto-detects project path via PIPELINE_WORKER_GITLAB_REPO_BASE', () => {
  withTempDir((dir) => {
    // Simulate: repoBase = dir, repoRoot = dir/Media/RetailMediaPortal
    const repoRoot = join(dir, 'Media', 'RetailMediaPortal');
    // We pass repoRoot as the "repo" location; no .pipeline-worker.yml there
    process.env.PIPELINE_WORKER_GITLAB_REPO_BASE = dir;
    const config = loadConfig(repoRoot);
    assert.equal(config.gitlab.projectId, 'media/retail-media-portal');
    assert.equal(config.gitlab.repoBase, dir);
  });
});

test('loadConfig: explicit projectId in YAML takes precedence over repoBase auto-detection', () => {
  withTempDir((dir) => {
    const repoRoot = join(dir, 'Media', 'SomeProject');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(
      join(repoRoot, '.pipeline-worker.yml'),
      'gitlab:\n  host: https://gitlab.example.com\n  projectId: 42\n',
    );
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

test('loadConfig: yaml github.repo takes precedence over origin-remote auto-detection', async () => {
  await withTempGitRepo('https://github.com/acme/widgets.git', async (dir) => {
    writeFileSync(join(dir, '.pipeline-worker.yml'), 'github:\n  repo: yaml-owner/yaml-repo\n');
    const config = loadConfig(dir);
    assert.equal(config.github.repo, 'yaml-owner/yaml-repo');
  });
});

test('loadConfig: env github.repo takes precedence over origin-remote auto-detection', async () => {
  await withTempGitRepo('https://github.com/acme/widgets.git', async (dir) => {
    process.env.PIPELINE_WORKER_GITHUB_REPO = 'env-owner/env-repo';
    const config = loadConfig(dir);
    assert.equal(config.github.repo, 'env-owner/env-repo');
  });
});