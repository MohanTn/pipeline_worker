import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { configFilePath } from '../src/config/file.js';

const execFileAsync = promisify(execFile);

/**
 * loadConfig reads exactly one file — $XDG_CONFIG_HOME/pipeline-worker/config.json
 * — so every test points XDG_CONFIG_HOME at a throwaway directory. Without
 * that, these assertions would run against (and, on first run, write into)
 * the real ~/.config of whoever runs the suite.
 */
let configHome: string;
let savedConfigHome: string | undefined;

beforeEach(() => {
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = mkdtempSync(join(tmpdir(), 'pipeline-worker-confighome-'));
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

/** Writes the settings file the loader will read for this test. */
function writeSettings(settings: Record<string, unknown>): void {
  const path = configFilePath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(settings), 'utf-8');
}

/** Captures console.error output (the loader's warning channel) while fn runs. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.error = originalError;
  }
  return warnings;
}

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

test('loadConfig returns defaults in an empty repo with no settings file', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.agent, 'claude');
    assert.equal(config.maxFixAttempts, 5);
    assert.equal(config.build, ''); // no toolchain marker in an empty dir: checks are skipped
  });
});

test('the first run creates config.json seeded with every default, so there is a file to edit', () => {
  withTempDir((dir) => {
    assert.equal(existsSync(configFilePath()), false);
    captureWarnings(() => loadConfig(dir));

    assert.equal(existsSync(configFilePath()), true);
    const written = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as Record<string, unknown>;
    assert.equal(written.agent, 'claude');
    assert.equal(written.forge, 'gitlab');
    assert.deepEqual(written.gitlab, { host: '', projectId: 0, repoBase: '', token: '' });
    assert.equal(written.switchToFeatureBranch, true);
    // build/lint/test stay out: they are auto-detected per repo, and one
    // global file serves every repo.
    assert.equal('build' in written, false);
  });
});

test('the created file announces itself, and a second run reads it instead of recreating it', () => {
  withTempDir((dir) => {
    const warnings = captureWarnings(() => loadConfig(dir));
    assert.ok(
      warnings.some((line) => line.includes('created') && line.includes(configFilePath())),
      `expected the created path to be announced, got: ${warnings.join(' | ')}`,
    );

    writeSettings({ agent: 'pi' });
    assert.equal(loadConfig(dir).agent, 'pi');
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

test('build/lint/test in the settings file override the detected defaults', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x', lint: 'y', test: 'z' } }));
    writeSettings({ build: 'make all', lint: 'make lint', test: 'make test' });
    const config = loadConfig(dir);
    assert.equal(config.build, 'make all');
    assert.equal(config.lint, 'make lint');
    assert.equal(config.test, 'make test');
  });
});

test('"build": "" explicitly skips the stage, even with a detected default', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    writeSettings({ build: '' });
    assert.equal(loadConfig(dir).build, '');
  });
});

test('loadConfig falls back to defaults (and never throws) on a malformed settings file', () => {
  withTempDir((dir) => {
    const path = configFilePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{ not json at all', 'utf-8');

    let config;
    const warnings = captureWarnings(() => {
      config = loadConfig(dir);
    });
    assert.equal(config!.agent, 'claude');
    assert.equal(config!.maxFixAttempts, 5);
    assert.ok(warnings.some((line) => line.includes(path)), `expected a warning naming the file, got: ${warnings.join(' | ')}`);
  });
});

test('a settings file holding a JSON array (not an object) degrades to defaults with a warning', () => {
  withTempDir((dir) => {
    const path = configFilePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '[]', 'utf-8');

    let config;
    const warnings = captureWarnings(() => {
      config = loadConfig(dir);
    });
    assert.equal(config!.agent, 'claude');
    assert.ok(warnings.some((line) => line.includes('not a JSON object')));
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

test('the settings file sets branchPattern and cleanupOnSuccess', () => {
  withTempDir((dir) => {
    writeSettings({ branchPattern: '{type}/{name}', cleanupOnSuccess: false });
    const config = loadConfig(dir);
    assert.equal(config.branchPattern, '{type}/{name}');
    assert.equal(config.cleanupOnSuccess, false);
  });
});

test('loadConfig defaults cleanupEarly to false and switchToFeatureBranch to true', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.cleanupEarly, false);
    assert.equal(config.switchToFeatureBranch, true);
  });
});

test('the settings file can turn switchToFeatureBranch off', () => {
  withTempDir((dir) => {
    writeSettings({ switchToFeatureBranch: false });
    assert.equal(loadConfig(dir).switchToFeatureBranch, false);
  });
});

test('"cleanupEarly": true sets cleanupEarly', () => {
  withTempDir((dir) => {
    writeSettings({ cleanupEarly: true });
    assert.equal(loadConfig(dir).cleanupEarly, true);
  });
});

test('loadConfig defaults intentModel to haiku, runLintAndTest to true, plainOutput to false', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.intentModel, 'haiku');
    assert.equal(config.runLintAndTest, true);
    assert.equal(config.plainOutput, false);
  });
});

test('"runLintAndTest": false overrides the default', () => {
  withTempDir((dir) => {
    writeSettings({ runLintAndTest: false });
    assert.equal(loadConfig(dir).runLintAndTest, false);
  });
});

test('boolean settings accept the usual string spellings, cased and padded — hand-edited files quote things', () => {
  withTempDir((dir) => {
    for (const value of ['false', 'FALSE', ' false ', '0', 'no', 'off']) {
      writeSettings({ runLintAndTest: value });
      assert.equal(loadConfig(dir).runLintAndTest, false, `expected ${JSON.stringify(value)} to disable lint/test`);
    }
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      writeSettings({ runLintAndTest: value });
      assert.equal(loadConfig(dir).runLintAndTest, true, `expected ${JSON.stringify(value)} to enable lint/test`);
    }
  });
});

test('an unparseable boolean setting falls back to the default and warns instead of failing silently', () => {
  withTempDir((dir) => {
    writeSettings({ runLintAndTest: 'flase' });
    let config;
    const warnings = captureWarnings(() => {
      config = loadConfig(dir);
    });
    assert.equal(config!.runLintAndTest, true);
    assert.ok(
      warnings.some((w) => w.includes('runLintAndTest') && w.includes('not a boolean')),
      `expected a warning naming the setting, got: ${warnings.join(' | ')}`,
    );
  });
});

test('an empty-string boolean setting falls back to the default without warning', () => {
  withTempDir((dir) => {
    writeSettings({ runLintAndTest: '' });
    const warnings = captureWarnings(() => {
      assert.equal(loadConfig(dir).runLintAndTest, true);
    });
    assert.ok(!warnings.some((w) => w.includes('runLintAndTest')));
  });
});

test('loadConfig defaults updateChangelog to false, and the file overrides it', () => {
  withTempDir((dir) => {
    assert.equal(loadConfig(dir).updateChangelog, false);
    writeSettings({ updateChangelog: true });
    assert.equal(loadConfig(dir).updateChangelog, true);
  });
});

test('intentModel and maxFixAttempts come from the file, and an invalid number falls back', () => {
  withTempDir((dir) => {
    writeSettings({ intentModel: 'sonnet', maxFixAttempts: 2 });
    const config = loadConfig(dir);
    assert.equal(config.intentModel, 'sonnet');
    assert.equal(config.maxFixAttempts, 2);

    writeSettings({ maxFixAttempts: 'not-a-number' });
    assert.equal(loadConfig(dir).maxFixAttempts, 5);
  });
});

test('loadConfig defaults autoMergeOnGreen to true — a run is meant to reach a merged, locally-synced result unattended', () => {
  withTempDir((dir) => {
    assert.equal(loadConfig(dir).autoMergeOnGreen, true);
  });
});

test('"autoMergeOnGreen": false restores the opt-in (manual-merge) behavior', () => {
  withTempDir((dir) => {
    writeSettings({ autoMergeOnGreen: false });
    assert.equal(loadConfig(dir).autoMergeOnGreen, false);
  });
});

test('loadConfig defaults squashOnMerge to false', () => {
  withTempDir((dir) => {
    assert.equal(loadConfig(dir).squashOnMerge, false);
  });
});

test('loadConfig warns when squashOnMerge is enabled alongside the default-on autoMergeOnGreen', () => {
  withTempDir((dir) => {
    writeSettings({ squashOnMerge: true });
    const warnings = captureWarnings(() => loadConfig(dir));
    assert.ok(warnings.some((w) => w.includes('squashOnMerge') && w.includes('autoMergeOnGreen')));
  });
});

test('loadConfig does not warn when squashOnMerge is enabled with auto-merge explicitly turned off', () => {
  withTempDir((dir) => {
    writeSettings({ squashOnMerge: true, autoMergeOnGreen: false });
    const warnings = captureWarnings(() => loadConfig(dir));
    assert.ok(!warnings.some((w) => w.includes('squashOnMerge')));
  });
});

test('the settings file sets forge, github.repo/token/apiUrl, and pollIntervalSeconds', () => {
  withTempDir((dir) => {
    writeSettings({
      forge: 'github',
      github: { repo: 'acme/widgets', token: 'ghp-x', apiUrl: 'https://github.acme.com/api/v3' },
      pollIntervalSeconds: 60,
    });
    const config = loadConfig(dir);
    assert.equal(config.forge, 'github');
    assert.equal(config.github.repo, 'acme/widgets');
    assert.equal(config.github.token, 'ghp-x');
    assert.equal(config.github.apiUrl, 'https://github.acme.com/api/v3');
    assert.equal(config.pollIntervalSeconds, 60);
  });
});

test('github.apiUrl defaults to the public API when the file omits it', () => {
  withTempDir((dir) => {
    assert.equal(loadConfig(dir).github.apiUrl, 'https://api.github.com');
    assert.equal(loadConfig(dir).github.token, '');
  });
});

test('the settings file sets gitlab.host/projectId/token', () => {
  withTempDir((dir) => {
    writeSettings({ gitlab: { host: 'https://gl.example.com', projectId: 99, token: 'glpat-x' } });
    const config = loadConfig(dir);
    assert.equal(config.gitlab.host, 'https://gl.example.com');
    assert.equal(config.gitlab.projectId, 99);
    assert.equal(config.gitlab.token, 'glpat-x');
  });
});

test('the settings file sets agent and forge', () => {
  withTempDir((dir) => {
    writeSettings({ agent: 'copilot', forge: 'github' });
    const config = loadConfig(dir);
    assert.equal(config.agent, 'copilot');
    assert.equal(config.forge, 'github');
  });
});

test('invalid agent/forge/poll values fall back to defaults instead of throwing', () => {
  withTempDir((dir) => {
    writeSettings({ agent: 'gpt', forge: 'bitbucket', pollIntervalSeconds: -3 });
    const config = loadConfig(dir);
    assert.equal(config.agent, 'claude');
    assert.equal(config.forge, 'gitlab');
    assert.equal(config.pollIntervalSeconds, 15);
  });
});

test('a malformed nested section is ignored rather than throwing', () => {
  withTempDir((dir) => {
    writeSettings({ gitlab: 'https://gl.example.com' });
    const config = loadConfig(dir);
    assert.equal(config.gitlab.host, '');
    assert.equal(config.gitlab.token, '');
  });
});

test('loadConfig accepts a non-numeric (namespace path) projectId', () => {
  withTempDir((dir) => {
    writeSettings({ gitlab: { host: 'https://gitlab.example.com', projectId: 'my-group/my-project' } });
    assert.equal(loadConfig(dir).gitlab.projectId, 'my-group/my-project');
  });
});

test('loadConfig auto-detects the project path from gitlab.repoBase', () => {
  withTempDir((dir) => {
    // Simulate: repoBase = dir, repoRoot = dir/Media/RetailMediaPortal
    const repoRoot = join(dir, 'Media', 'RetailMediaPortal');
    writeSettings({ gitlab: { repoBase: dir } });
    const config = loadConfig(repoRoot);
    assert.equal(config.gitlab.projectId, 'media/retail-media-portal');
    assert.equal(config.gitlab.repoBase, dir);
  });
});

test('loadConfig: an explicit gitlab.projectId takes precedence over repoBase auto-detection', () => {
  withTempDir((dir) => {
    const repoRoot = join(dir, 'Media', 'SomeProject');
    mkdirSync(repoRoot, { recursive: true });
    writeSettings({ gitlab: { host: 'https://gitlab.example.com', projectId: 42, repoBase: dir } });
    assert.equal(loadConfig(repoRoot).gitlab.projectId, 42);
  });
});

test('loadConfig auto-detects github.repo from the origin remote when the file omits it', async () => {
  await withTempGitRepo('https://github.com/acme/widgets.git', (dir) => {
    assert.equal(loadConfig(dir).github.repo, 'acme/widgets');
  });
});

test('loadConfig: github.repo in the file takes precedence over origin-remote auto-detection', async () => {
  await withTempGitRepo('https://github.com/acme/widgets.git', (dir) => {
    writeSettings({ github: { repo: 'file-owner/file-repo' } });
    assert.equal(loadConfig(dir).github.repo, 'file-owner/file-repo');
  });
});

test('agent hardening defaults: bare mode on, little-coder binary and a small prompt budget', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.bareAgentMode, true);
    assert.deepEqual(config.littleCoder, { binary: 'little-coder', maxPromptChars: 12_000 });
  });
});

test('bareAgentMode can be turned off — a subscription (OAuth) claude sign-in cannot use --bare', () => {
  withTempDir((dir) => {
    writeSettings({ bareAgentMode: false });
    assert.equal(loadConfig(dir).bareAgentMode, false);
  });
});

test('bare mode with no ANTHROPIC_API_KEY warns at load time, since --bare never reads OAuth or the keychain', () => {
  withTempDir((dir) => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const warnings = captureWarnings(() => loadConfig(dir));
      assert.ok(
        warnings.some((w) => w.includes('bareAgentMode') && w.includes('ANTHROPIC_API_KEY')),
        `expected a warning about bare-mode auth, got: ${warnings.join(' | ')}`,
      );

      // Silent once a key exists, and silent for a non-claude agent (no --bare there to break).
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      assert.ok(!captureWarnings(() => loadConfig(dir)).some((w) => w.includes('bareAgentMode')));
      delete process.env.ANTHROPIC_API_KEY;
      writeSettings({ agent: 'little-coder' });
      assert.ok(!captureWarnings(() => loadConfig(dir)).some((w) => w.includes('bareAgentMode')));
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});

test('the littleCoder section is configurable, and maxPromptChars accepts 0 as "no cap"', () => {
  withTempDir((dir) => {
    writeSettings({ agent: 'little-coder', littleCoder: { binary: '/opt/little-coder/bin/little-coder', maxPromptChars: 0 } });
    const config = loadConfig(dir);
    assert.equal(config.agent, 'little-coder');
    assert.equal(config.littleCoder.binary, '/opt/little-coder/bin/little-coder');
    assert.equal(config.littleCoder.maxPromptChars, 0);
  });
});

test('a negative or unparseable maxPromptChars falls back to the default instead of disabling the cap', () => {
  withTempDir((dir) => {
    writeSettings({ littleCoder: { maxPromptChars: -1 } });
    assert.equal(loadConfig(dir).littleCoder.maxPromptChars, 12_000);
    writeSettings({ littleCoder: { maxPromptChars: 'lots' } });
    assert.equal(loadConfig(dir).littleCoder.maxPromptChars, 12_000);
  });
});

test('review config defaults to off, MAJOR-only, 10 comments', () => {
  withTempDir((dir) => {
    const config = loadConfig(dir);
    assert.equal(config.review, false); // opt-in: it spends tokens and writes where humans read
    assert.equal(config.reviewModel, ''); // '' = the adapter's default (stronger) model
    assert.equal(config.reviewMinSeverity, 'MAJOR');
    assert.equal(config.reviewMaxComments, 10);
    assert.equal(config.reviewChunkChars, 24_000);
  });
});

test('review* settings are honored, severity case-insensitively', () => {
  withTempDir((dir) => {
    writeSettings({
      review: true,
      reviewModel: 'sonnet',
      reviewMinSeverity: 'critical',
      reviewMaxComments: 3,
      reviewChunkChars: 8000,
    });
    const config = loadConfig(dir);
    assert.equal(config.review, true);
    assert.equal(config.reviewModel, 'sonnet');
    assert.equal(config.reviewMinSeverity, 'CRITICAL');
    assert.equal(config.reviewMaxComments, 3);
    assert.equal(config.reviewChunkChars, 8000);
  });
});

test('an unrecognized reviewMinSeverity falls back to MAJOR with a warning, never silently', () => {
  withTempDir((dir) => {
    writeSettings({ reviewMinSeverity: 'nitpick' });
    let config;
    const warnings = captureWarnings(() => {
      config = loadConfig(dir);
    });
    assert.equal(config!.reviewMinSeverity, 'MAJOR');
    assert.ok(
      warnings.some((line) => line.includes('reviewMinSeverity')),
      `expected a warning naming the setting, got: ${JSON.stringify(warnings)}`,
    );
  });
});

test('PIPELINE_WORKER_* environment variables no longer configure anything', () => {
  withTempDir((dir) => {
    process.env.PIPELINE_WORKER_AGENT = 'copilot';
    process.env.PIPELINE_WORKER_FORGE = 'github';
    try {
      const config = loadConfig(dir);
      assert.equal(config.agent, 'claude');
      assert.equal(config.forge, 'gitlab');
    } finally {
      delete process.env.PIPELINE_WORKER_AGENT;
      delete process.env.PIPELINE_WORKER_FORGE;
    }
  });
});

test('a repo-root .env file is no longer read', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'PIPELINE_WORKER_FORGE=github\n');
    assert.equal(loadConfig(dir).forge, 'gitlab');
  });
});
