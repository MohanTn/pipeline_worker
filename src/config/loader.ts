/**
 * .pipeline-worker.yml loader. Resolution order per value: environment variable ->
 * .env file at repo root (never overrides real env) -> .pipeline-worker.yml ->
 * built-in default (for build/lint/test: commands auto-detected from the repo's
 * toolchain, see detectChecks.ts; for github.repo: the repo's own `origin`
 * remote, see git/remote.ts). Config file path: explicit override param ->
 * PIPELINE_WORKER_CONFIG env var -> <repoRoot>/.pipeline-worker.yml. Never throws — a
 * missing or unparseable file falls back to defaults (with a warning),
 * mirroring mcp-sonar-analysis's registry.ts read/never-throw contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { load } from 'js-yaml';
import { detectChecks } from './detectChecks.js';
import { deriveProjectPath } from '../git/resolveProjectPath.js';
import { detectGithubRepo } from '../git/remote.js';
import type { AgentName, ForgeName, PipelineWorkerConfig } from '../types.js';

const CONFIG_FILE_NAME = '.pipeline-worker.yml';

const AGENT_NAMES: readonly AgentName[] = ['claude', 'copilot'];
const FORGE_NAMES: readonly ForgeName[] = ['gitlab', 'github'];

// build/lint/test defaults come from detectChecks(repoRoot) at load time.
const DEFAULT_CONFIG: Omit<PipelineWorkerConfig, 'build' | 'lint' | 'test'> = {
  agent: 'claude',
  forge: 'gitlab',
  gitlab: {
    host: '',
    projectId: 0,
  },
  github: {
    repo: '',
  },
  maxFixAttempts: 5,
  pollIntervalSeconds: 15,
};

/** Loads <repoRoot>/.env into process.env; already-set variables always win. */
function loadDotEnv(repoRoot: string): void {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return;
  try {
    const parsed = parseEnv(readFileSync(envPath, 'utf-8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to read ${envPath}: ${message}. Ignoring it.`);
  }
}

function pickName<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Parses a positive number, falling back when unset or invalid. */
function positiveNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function resolveConfigPath(repoRoot: string, override?: string): string {
  return override || process.env.PIPELINE_WORKER_CONFIG || join(repoRoot, CONFIG_FILE_NAME);
}

function readYamlConfig(configPath: string): Partial<PipelineWorkerConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return (load(readFileSync(configPath, 'utf-8')) as Partial<PipelineWorkerConfig>) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to read ${configPath}: ${message}. Falling back to defaults.`);
    return {};
  }
}

export function loadConfig(repoRoot: string, override?: string): PipelineWorkerConfig {
  loadDotEnv(repoRoot); // before resolveConfigPath so PIPELINE_WORKER_CONFIG can also come from .env

  const parsed = readYamlConfig(resolveConfigPath(repoRoot, override));

  const detected = detectChecks(repoRoot);
  if (detected.language === 'unknown' && parsed.build === undefined && parsed.lint === undefined && parsed.test === undefined) {
    console.error(`Warning: could not detect the toolchain of ${repoRoot}; build/lint/test will be skipped. Set them in ${CONFIG_FILE_NAME}.`);
  }

  // Each tier is validated independently: an invalid env value falls back to
  // a valid yaml value, not straight to the built-in default.

  // Resolve the repoBase: env var wins over YAML value
  const repoBase = process.env.PIPELINE_WORKER_GITLAB_REPO_BASE || parsed.gitlab?.repoBase;

  // Resolve projectId: YAML value is authoritative; when unset, fall back to
  // auto-detecting a string path from repoBase. projectId can legitimately be
  // a string (a 'group/subgroup/project' path), so it is kept as-is below
  // rather than coerced through positiveNumber, which is number-only.
  let resolvedProjectId: number | string = parsed.gitlab?.projectId ?? DEFAULT_CONFIG.gitlab.projectId;
  if (!resolvedProjectId && repoBase) {
    try {
      resolvedProjectId = deriveProjectPath(repoBase, repoRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: ${message}`);
    }
  }

  // The env var override is numeric-only (GitLab numeric project IDs); an
  // unset or invalid value falls back to the yaml/auto-detected resolution
  // above, which may be a string path.
  const envProjectId = positiveNumber(process.env.PIPELINE_WORKER_GITLAB_PROJECT_ID, NaN);
  const projectId = Number.isNaN(envProjectId) ? resolvedProjectId : envProjectId;

  return {
    agent: pickName<AgentName>(process.env.PIPELINE_WORKER_AGENT, AGENT_NAMES, pickName(parsed.agent, AGENT_NAMES, DEFAULT_CONFIG.agent)),
    forge: pickName<ForgeName>(process.env.PIPELINE_WORKER_FORGE, FORGE_NAMES, pickName(parsed.forge, FORGE_NAMES, DEFAULT_CONFIG.forge)),
    gitlab: {
      host: process.env.PIPELINE_WORKER_GITLAB_HOST || parsed.gitlab?.host || DEFAULT_CONFIG.gitlab.host,
      projectId,
      repoBase,
    },
    github: {
      repo: process.env.PIPELINE_WORKER_GITHUB_REPO || parsed.github?.repo || detectGithubRepo(repoRoot) || DEFAULT_CONFIG.github.repo,
    },
    build: parsed.build ?? detected.build,
    lint: parsed.lint ?? detected.lint,
    test: parsed.test ?? detected.test,
    maxFixAttempts: parsed.maxFixAttempts ?? DEFAULT_CONFIG.maxFixAttempts,
    pollIntervalSeconds: positiveNumber(
      process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS,
      positiveNumber(parsed.pollIntervalSeconds, DEFAULT_CONFIG.pollIntervalSeconds),
    ),
  };
}
