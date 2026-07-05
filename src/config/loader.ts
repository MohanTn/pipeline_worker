/**
 * Environment-variable config resolver. Resolution order per value:
 * environment variable -> .env file at repo root (never overrides real env) ->
 * built-in default (for build/lint/test: commands auto-detected from the
 * repo's toolchain, see detectChecks.ts; for github.repo: the repo's own
 * `origin` remote, see git/remote.ts). Never throws — an unset or invalid
 * value falls back to the default (with a warning where relevant), mirroring
 * mcp-sonar-analysis's registry.ts read/never-throw contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { detectChecks } from './detectChecks.js';
import { deriveProjectPath } from '../git/resolveProjectPath.js';
import { detectGithubRepo } from '../git/remote.js';
import type { AgentName, ForgeName, PipelineWorkerConfig } from '../types.js';

const AGENT_NAMES: readonly AgentName[] = ['claude', 'copilot', 'pi'];
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
  branchPattern: 'pipeline-worker/{name}',
  cleanupOnSuccess: true,
  cleanupEarly: false,
  intentModel: 'haiku',
  runLintAndTest: true,
  updateChangelog: false,
};

/** Loads <repoRoot>/.env into process.env; already-set variables always win. */
// fallow-ignore-next-line complexity
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

/** Parses "true"/"false" (case-insensitive), falling back when unset or unrecognized. */
// fallow-ignore-next-line complexity
function boolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

/**
 * Unlike `||`-based resolution, an env var explicitly set to `''` (e.g.
 * `PIPELINE_WORKER_BUILD=`) is honored as "skip this stage" rather than
 * falling through to the detected default — only a genuinely unset var falls
 * back.
 */
function stringOr(value: string | undefined, fallback: string): string {
  return value !== undefined ? value : fallback;
}

/** GitLab project ids are either numeric or a 'group/subgroup/project' path; numeric strings are coerced, everything else is kept as-is. */
function resolveProjectId(value: string | undefined, fallback: number | string): number | string {
  if (!value) return fallback;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : value;
}

/** Warns once when no toolchain was auto-detected and none of the build/lint/test env overrides are set — checks will otherwise silently be skipped. */
// fallow-ignore-next-line complexity
function warnIfToolchainUndetected(repoRoot: string, detected: ReturnType<typeof detectChecks>): void {
  if (
    detected.language === 'unknown' &&
    process.env.PIPELINE_WORKER_BUILD === undefined &&
    process.env.PIPELINE_WORKER_LINT === undefined &&
    process.env.PIPELINE_WORKER_TEST === undefined
  ) {
    console.error(
      `Warning: could not detect the toolchain of ${repoRoot}; build/lint/test will be skipped. ` +
        'Set PIPELINE_WORKER_BUILD / PIPELINE_WORKER_LINT / PIPELINE_WORKER_TEST to configure them explicitly.',
    );
  }
}

/** Auto-detects a string path from repoBase when no project id is configured yet; the env var override (numeric or string path) always wins. */
// fallow-ignore-next-line complexity
function resolveGitlabProjectId(repoRoot: string, repoBase: string | undefined): number | string {
  let resolvedProjectId: number | string = DEFAULT_CONFIG.gitlab.projectId;
  if (!resolvedProjectId && repoBase) {
    try {
      resolvedProjectId = deriveProjectPath(repoBase, repoRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: ${message}`);
    }
  }
  return resolveProjectId(process.env.PIPELINE_WORKER_GITLAB_PROJECT_ID, resolvedProjectId);
}

function buildGitlabSection(repoRoot: string, repoBase: string | undefined): PipelineWorkerConfig['gitlab'] {
  return {
    host: process.env.PIPELINE_WORKER_GITLAB_HOST || DEFAULT_CONFIG.gitlab.host,
    projectId: resolveGitlabProjectId(repoRoot, repoBase),
    repoBase,
  };
}

function buildGithubSection(repoRoot: string): PipelineWorkerConfig['github'] {
  return {
    repo: process.env.PIPELINE_WORKER_GITHUB_REPO || detectGithubRepo(repoRoot) || DEFAULT_CONFIG.github.repo,
  };
}

export function loadConfig(repoRoot: string): PipelineWorkerConfig {
  loadDotEnv(repoRoot);

  const detected = detectChecks(repoRoot);
  warnIfToolchainUndetected(repoRoot, detected);

  const repoBase = process.env.PIPELINE_WORKER_GITLAB_REPO_BASE;

  return {
    agent: pickName<AgentName>(process.env.PIPELINE_WORKER_AGENT, AGENT_NAMES, DEFAULT_CONFIG.agent),
    forge: pickName<ForgeName>(process.env.PIPELINE_WORKER_FORGE, FORGE_NAMES, DEFAULT_CONFIG.forge),
    gitlab: buildGitlabSection(repoRoot, repoBase),
    github: buildGithubSection(repoRoot),
    build: stringOr(process.env.PIPELINE_WORKER_BUILD, detected.build),
    lint: stringOr(process.env.PIPELINE_WORKER_LINT, detected.lint),
    test: stringOr(process.env.PIPELINE_WORKER_TEST, detected.test),
    maxFixAttempts: positiveNumber(process.env.PIPELINE_WORKER_MAX_FIX_ATTEMPTS, DEFAULT_CONFIG.maxFixAttempts),
    pollIntervalSeconds: positiveNumber(process.env.PIPELINE_WORKER_POLL_INTERVAL_SECONDS, DEFAULT_CONFIG.pollIntervalSeconds),
    branchPattern: process.env.PIPELINE_WORKER_BRANCH_PATTERN || DEFAULT_CONFIG.branchPattern,
    cleanupOnSuccess: boolean(process.env.PIPELINE_WORKER_CLEANUP, DEFAULT_CONFIG.cleanupOnSuccess),
    cleanupEarly: boolean(process.env.PIPELINE_WORKER_CLEANUP_EARLY, DEFAULT_CONFIG.cleanupEarly),
    intentModel: process.env.PIPELINE_WORKER_INTENT_MODEL || DEFAULT_CONFIG.intentModel,
    runLintAndTest: boolean(process.env.PIPELINE_WORKER_RUN_LINT_AND_TEST, DEFAULT_CONFIG.runLintAndTest),
    updateChangelog: boolean(process.env.PIPELINE_WORKER_UPDATE_CHANGELOG, DEFAULT_CONFIG.updateChangelog),
  };
}
