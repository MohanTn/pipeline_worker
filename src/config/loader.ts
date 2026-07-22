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
import type { AgentName, ForgeName, MergeMethod, PipelineWorkerConfig } from '../types.js';

const AGENT_NAMES: readonly AgentName[] = ['claude', 'copilot', 'pi'];
const FORGE_NAMES: readonly ForgeName[] = ['gitlab', 'github'];
const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

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
  // Default-on: a run is meant to go all the way to a merged, locally-synced
  // result unattended (see maybeSyncTargetBranch) — merging remains
  // best-effort and never fails the run, and PIPELINE_WORKER_AUTO_MERGE_ON_GREEN=false
  // restores the old opt-in behavior for anyone who wants to merge by hand.
  autoMergeOnGreen: true,
  mergeMethod: 'squash',
  squashOnMerge: false,
  completionSound: true,
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

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

/**
 * Parses a boolean env var: the usual spellings (true/false, 1/0, yes/no,
 * on/off), case-insensitive and whitespace-tolerant. An unset or empty value
 * falls back silently; anything else falls back *with a warning* — a typo'd
 * or shell-quoted value used to silently resolve to the default, which for
 * gating flags like PIPELINE_WORKER_RUN_LINT_AND_TEST meant the stage the
 * user asked to skip ran anyway with no hint why.
 */
// fallow-ignore-next-line complexity
function boolean(name: string, value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return fallback;
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    console.error(
      `Warning: ${name}=${JSON.stringify(value)} is not a boolean — using ${fallback}. ` +
        'Accepted values: true/false, 1/0, yes/no, on/off.',
    );
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

/**
 * squashOnMerge force-pushes a collapsed history onto the branch after CI is
 * green; with autoMergeOnGreen also on, the forge may already have merged
 * (and possibly deleted) that branch via its own webhook before the squash
 * push runs — see maybeSquashCommits, which reduces that race to a low-risk
 * note rather than failing the run. Surfacing it here too, at config load
 * time, means the user sees it before the run even starts.
 */
function warnIfSquashRacesAutoMerge(autoMergeOnGreen: boolean, squashOnMerge: boolean): void {
  if (autoMergeOnGreen && squashOnMerge) {
    console.error(
      'Warning: PIPELINE_WORKER_SQUASH_ON_MERGE is enabled alongside PIPELINE_WORKER_AUTO_MERGE_ON_GREEN — ' +
        'the forge may merge (and delete) the branch before the squash push runs. This is best-effort and will ' +
        'not fail the run, but the squash may silently no-op.',
    );
  }
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
  const autoMergeOnGreen = boolean('PIPELINE_WORKER_AUTO_MERGE_ON_GREEN', process.env.PIPELINE_WORKER_AUTO_MERGE_ON_GREEN, DEFAULT_CONFIG.autoMergeOnGreen);
  const squashOnMerge = boolean('PIPELINE_WORKER_SQUASH_ON_MERGE', process.env.PIPELINE_WORKER_SQUASH_ON_MERGE, DEFAULT_CONFIG.squashOnMerge);
  warnIfSquashRacesAutoMerge(autoMergeOnGreen, squashOnMerge);

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
    cleanupOnSuccess: boolean('PIPELINE_WORKER_CLEANUP', process.env.PIPELINE_WORKER_CLEANUP, DEFAULT_CONFIG.cleanupOnSuccess),
    cleanupEarly: boolean('PIPELINE_WORKER_CLEANUP_EARLY', process.env.PIPELINE_WORKER_CLEANUP_EARLY, DEFAULT_CONFIG.cleanupEarly),
    intentModel: process.env.PIPELINE_WORKER_INTENT_MODEL || DEFAULT_CONFIG.intentModel,
    runLintAndTest: boolean('PIPELINE_WORKER_RUN_LINT_AND_TEST', process.env.PIPELINE_WORKER_RUN_LINT_AND_TEST, DEFAULT_CONFIG.runLintAndTest),
    updateChangelog: boolean('PIPELINE_WORKER_UPDATE_CHANGELOG', process.env.PIPELINE_WORKER_UPDATE_CHANGELOG, DEFAULT_CONFIG.updateChangelog),
    autoMergeOnGreen,
    mergeMethod: pickName<MergeMethod>(process.env.PIPELINE_WORKER_MERGE_METHOD, MERGE_METHODS, DEFAULT_CONFIG.mergeMethod),
    squashOnMerge,
    completionSound: boolean('PIPELINE_WORKER_COMPLETION_SOUND', process.env.PIPELINE_WORKER_COMPLETION_SOUND, DEFAULT_CONFIG.completionSound),
  };
}
