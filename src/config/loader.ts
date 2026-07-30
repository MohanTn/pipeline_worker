/**
 * Config resolver. Resolution order per value: the settings file
 * (~/.config/pipeline-worker/config.json, see file.ts) -> built-in default
 * (for build/lint/test: commands auto-detected from the repo's toolchain, see
 * detectChecks.ts; for github.repo: the repo's own `origin` remote, see
 * git/remote.ts; for gitlab.projectId: derived from gitlab.repoBase).
 *
 * The settings file is the only source — pipeline-worker reads no
 * PIPELINE_WORKER_* environment variables and no per-repo config file, so one
 * file describes every repo you run in and the per-repo values keep coming
 * from auto-detection. Never throws: an unset or invalid value falls back to
 * the default (with a warning where relevant), mirroring mcp-sonar-analysis's
 * registry.ts read/never-throw contract.
 */

import { configFilePath, readRawConfig, writeDefaultConfig } from './file.js';
import { detectChecks } from './detectChecks.js';
import { deriveProjectPath } from '../git/resolveProjectPath.js';
import { detectGithubRepo } from '../git/remote.js';
import type { AgentName, ForgeName, MergeMethod, PipelineWorkerConfig } from '../types.js';
import type { ReviewSeverity } from '../review/types.js';

const AGENT_NAMES: readonly AgentName[] = ['claude', 'copilot', 'pi', 'little-coder'];
const FORGE_NAMES: readonly ForgeName[] = ['gitlab', 'github'];
const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];
const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['CRITICAL', 'MAJOR', 'MINOR'];

/**
 * Also the template written to config.json on first run, so the file the user
 * opens lists every key with its default — build/lint/test are left out on
 * purpose: they come from detectChecks(repoRoot) unless the file names them.
 *
 * Exported so the TUI's settings editor and setup wizard can show "the default
 * for this key" without keeping a second copy of these values in sync.
 */
export const DEFAULT_CONFIG: Omit<PipelineWorkerConfig, 'build' | 'lint' | 'test'> = {
  agent: 'claude',
  forge: 'gitlab',
  gitlab: {
    host: '',
    projectId: 0,
    repoBase: '',
    token: '',
  },
  github: {
    repo: '',
    token: '',
    apiUrl: 'https://api.github.com',
  },
  maxFixAttempts: 5,
  pollIntervalSeconds: 15,
  branchPattern: 'pipeline-worker/{name}',
  cleanupOnSuccess: true,
  cleanupEarly: false,
  intentModel: 'haiku',
  bareAgentMode: true,
  littleCoder: {
    binary: 'little-coder',
    // Comfortably inside a 8k-token context once the model's own system
    // prompt and answer are accounted for; raise it for a bigger local model.
    maxPromptChars: 12_000,
  },
  runLintAndTest: true,
  updateChangelog: false,
  // Default-on: a run is meant to go all the way to a merged, locally-synced
  // result unattended (see maybeSyncTargetBranch) — merging remains
  // best-effort and never fails the run, and "autoMergeOnGreen": false
  // restores the old opt-in behavior for anyone who wants to merge by hand.
  autoMergeOnGreen: true,
  mergeMethod: 'squash',
  squashOnMerge: false,
  completionSound: true,
  review: false,
  // Named rather than left empty on purpose: an empty model sends no --model
  // flag at all, which hands the choice to the agent CLI's own default. That
  // default now tracks the newest, most expensive model (Fable-class), which an
  // OAuth/subscription sign-in cannot reach — so the review step failed outright
  // for anyone who had not set this key. Sonnet is reachable on every tier and
  // still well clear of intentModel's haiku, which is the point of the setting.
  reviewModel: 'sonnet',
  reviewMinSeverity: 'MAJOR',
  reviewMaxComments: 10,
  // ~200k chars (~50k tokens) of diff in one turn: enough that a normal MR/PR
  // is reviewed in a single agent session rather than one session per file,
  // each of which would re-pay the agent CLI's own system prompt and tool
  // definitions. Only a genuinely huge diff splits across turns.
  reviewChunkChars: 200_000,
  reviewFilesPerTurn: 0,
  // Default-on: the whole point of the run is that the change now lives on
  // that branch, so leaving the caller standing on it is what makes the next
  // edit a follow-up commit instead of a second, unrelated MR/PR.
  switchToFeatureBranch: true,
  plainOutput: false,
};

/** The settings file's contents, creating it with the defaults on first run. */
function readSettings(): Record<string, unknown> {
  const path = configFilePath();
  const raw = readRawConfig(path);
  if (raw) return raw;
  writeDefaultConfig(DEFAULT_CONFIG, path);
  return {};
}

/** A nested settings object ("gitlab", "github"), or an empty one when absent or malformed. */
function section(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = settings[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A configured string, or undefined when the key is absent (or holds a non-string). */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pickName<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Parses a positive number, falling back when unset or invalid. */
function positiveNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/** Like positiveNumber, but 0 is accepted — used where 0 means "unlimited". */
function nonNegativeNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

/**
 * Parses a boolean setting: a real JSON boolean, or the usual string
 * spellings (true/false, 1/0, yes/no, on/off), case-insensitive and
 * whitespace-tolerant — hand-edited files carry quoted values often enough to
 * be worth accepting. An absent or empty value falls back silently; anything
 * else falls back *with a warning* — a typo'd value used to silently resolve
 * to the default, which for gating flags like runLintAndTest meant the stage
 * the user asked to skip ran anyway with no hint why.
 */
// fallow-ignore-next-line complexity
function boolean(name: string, value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return fallback;
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
  }
  if (value !== undefined && value !== null) {
    console.error(
      `Warning: ${name}=${JSON.stringify(value)} in ${configFilePath()} is not a boolean — using ${fallback}. ` +
        'Accepted values: true/false, 1/0, yes/no, on/off.',
    );
  }
  return fallback;
}

/**
 * Unlike `||`-based resolution, a key explicitly set to `""` (e.g.
 * `"build": ""`) is honored as "skip this stage" rather than falling through
 * to the detected default — only an absent key falls back.
 */
function stringOr(value: string | undefined, fallback: string): string {
  return value !== undefined ? value : fallback;
}

/**
 * Agents whose CLI understands the bare `haiku`/`sonnet`/`opus` aliases —
 * claude natively, copilot by translation (see agent/copilot.ts). pi and
 * little-coder take a `provider/id` instead, so handing them an alias would
 * name a model their runtime has never heard of.
 */
const ALIAS_MODEL_AGENTS: readonly AgentName[] = ['claude', 'copilot'];

/** The reviewModel default for this agent: the named default where an alias means something, the adapter's own default where it does not. */
function defaultReviewModel(agent: AgentName): string {
  return ALIAS_MODEL_AGENTS.includes(agent) ? DEFAULT_CONFIG.reviewModel : '';
}

/** GitLab project ids are either numeric or a 'group/subgroup/project' path; numeric strings are coerced, everything else is kept as-is. */
// fallow-ignore-next-line complexity
function resolveProjectId(value: unknown, fallback: number | string): number | string {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : fallback;
  const configured = str(value);
  if (!configured) return fallback;
  const num = Number(configured);
  return Number.isFinite(num) && num > 0 ? num : configured;
}

/**
 * Like pickName, but warns on an unrecognized value the way boolean() does —
 * a typo'd reviewMinSeverity would otherwise silently widen (or narrow) what
 * gets posted with no hint why. Case-insensitive: `major` is the spelling
 * most people reach for.
 */
function pickSeverity(value: unknown, fallback: ReviewSeverity): ReviewSeverity {
  const normalized = (str(value) ?? '').trim().toUpperCase();
  if (normalized === '') return fallback;
  if (REVIEW_SEVERITIES.includes(normalized as ReviewSeverity)) return normalized as ReviewSeverity;
  console.error(
    `Warning: reviewMinSeverity=${JSON.stringify(value)} in ${configFilePath()} is not a severity — using ${fallback}. ` +
      `Accepted values: ${REVIEW_SEVERITIES.join('/')}.`,
  );
  return fallback;
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
      'Warning: squashOnMerge is enabled alongside autoMergeOnGreen — ' +
        'the forge may merge (and delete) the branch before the squash push runs. This is best-effort and will ' +
        'not fail the run, but the squash may silently no-op.',
    );
  }
}

/**
 * `--bare` makes claude read its Anthropic credentials *only* from
 * ANTHROPIC_API_KEY (or an apiKeyHelper supplied via --settings): OAuth and the
 * keychain are never consulted. Verified against the installed CLI — the same
 * turn that succeeds without `--bare` comes back
 * `"terminal_reason":"api_error"` with it when no key is exported. That is a
 * silent-looking failure on every agent turn of a run, so it is called out at
 * load time, before any work starts.
 */
function warnIfBareModeHasNoApiKey(agent: AgentName, bareAgentMode: boolean): void {
  if (agent === 'claude' && bareAgentMode && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Warning: bareAgentMode is on and ANTHROPIC_API_KEY is not set. `claude --bare` never reads OAuth or keychain ' +
        'credentials, so agent turns will fail with an API error unless your claude settings supply an apiKeyHelper. ' +
        `Export ANTHROPIC_API_KEY, or set "bareAgentMode": false in ${configFilePath()}.`,
    );
  }
}

/** Warns once when no toolchain was auto-detected and the settings file names no build/lint/test command — checks will otherwise silently be skipped. */
// fallow-ignore-next-line complexity
function warnIfToolchainUndetected(repoRoot: string, settings: Record<string, unknown>, detected: ReturnType<typeof detectChecks>): void {
  if (detected.language === 'unknown' && str(settings.build) === undefined && str(settings.lint) === undefined && str(settings.test) === undefined) {
    console.error(
      `Warning: could not detect the toolchain of ${repoRoot}; build/lint/test will be skipped. ` +
        `Set "build" / "lint" / "test" in ${configFilePath()} to configure them explicitly.`,
    );
  }
}

/** Auto-detects a string path from repoBase when the settings file configures no project id; the configured value (numeric or string path) always wins. */
// fallow-ignore-next-line complexity
function resolveGitlabProjectId(repoRoot: string, gitlab: Record<string, unknown>, repoBase: string | undefined): number | string {
  let resolvedProjectId: number | string = DEFAULT_CONFIG.gitlab.projectId;
  if (!resolvedProjectId && repoBase) {
    try {
      resolvedProjectId = deriveProjectPath(repoBase, repoRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: ${message}`);
    }
  }
  return resolveProjectId(gitlab.projectId, resolvedProjectId);
}

function buildGitlabSection(repoRoot: string, gitlab: Record<string, unknown>, repoBase: string | undefined): PipelineWorkerConfig['gitlab'] {
  return {
    host: str(gitlab.host) || DEFAULT_CONFIG.gitlab.host,
    projectId: resolveGitlabProjectId(repoRoot, gitlab, repoBase),
    repoBase,
    token: str(gitlab.token) || DEFAULT_CONFIG.gitlab.token,
  };
}

function buildLittleCoderSection(littleCoder: Record<string, unknown>): PipelineWorkerConfig['littleCoder'] {
  return {
    binary: str(littleCoder.binary) || DEFAULT_CONFIG.littleCoder.binary,
    // 0 is a meaningful value here ("no cap"), so it can't go through
    // positiveNumber — only a negative or unparseable value falls back.
    maxPromptChars: nonNegativeNumber(littleCoder.maxPromptChars, DEFAULT_CONFIG.littleCoder.maxPromptChars),
  };
}

function buildGithubSection(repoRoot: string, github: Record<string, unknown>): PipelineWorkerConfig['github'] {
  return {
    repo: str(github.repo) || detectGithubRepo(repoRoot) || DEFAULT_CONFIG.github.repo,
    token: str(github.token) || DEFAULT_CONFIG.github.token,
    apiUrl: str(github.apiUrl) || DEFAULT_CONFIG.github.apiUrl,
  };
}

// fallow-ignore-next-line complexity
export function loadConfig(repoRoot: string): PipelineWorkerConfig {
  const settings = readSettings();
  const gitlab = section(settings, 'gitlab');
  const github = section(settings, 'github');

  const detected = detectChecks(repoRoot);
  warnIfToolchainUndetected(repoRoot, settings, detected);

  const repoBase = str(gitlab.repoBase) || undefined;
  const agent = pickName<AgentName>(settings.agent, AGENT_NAMES, DEFAULT_CONFIG.agent);
  const bareAgentMode = boolean('bareAgentMode', settings.bareAgentMode, DEFAULT_CONFIG.bareAgentMode);
  warnIfBareModeHasNoApiKey(agent, bareAgentMode);
  const autoMergeOnGreen = boolean('autoMergeOnGreen', settings.autoMergeOnGreen, DEFAULT_CONFIG.autoMergeOnGreen);
  const squashOnMerge = boolean('squashOnMerge', settings.squashOnMerge, DEFAULT_CONFIG.squashOnMerge);
  warnIfSquashRacesAutoMerge(autoMergeOnGreen, squashOnMerge);

  return {
    agent,
    forge: pickName<ForgeName>(settings.forge, FORGE_NAMES, DEFAULT_CONFIG.forge),
    gitlab: buildGitlabSection(repoRoot, gitlab, repoBase),
    github: buildGithubSection(repoRoot, github),
    build: stringOr(str(settings.build), detected.build),
    lint: stringOr(str(settings.lint), detected.lint),
    test: stringOr(str(settings.test), detected.test),
    maxFixAttempts: positiveNumber(settings.maxFixAttempts, DEFAULT_CONFIG.maxFixAttempts),
    pollIntervalSeconds: positiveNumber(settings.pollIntervalSeconds, DEFAULT_CONFIG.pollIntervalSeconds),
    branchPattern: str(settings.branchPattern) || DEFAULT_CONFIG.branchPattern,
    cleanupOnSuccess: boolean('cleanupOnSuccess', settings.cleanupOnSuccess, DEFAULT_CONFIG.cleanupOnSuccess),
    cleanupEarly: boolean('cleanupEarly', settings.cleanupEarly, DEFAULT_CONFIG.cleanupEarly),
    intentModel: str(settings.intentModel) || DEFAULT_CONFIG.intentModel,
    bareAgentMode,
    littleCoder: buildLittleCoderSection(section(settings, 'littleCoder')),
    runLintAndTest: boolean('runLintAndTest', settings.runLintAndTest, DEFAULT_CONFIG.runLintAndTest),
    updateChangelog: boolean('updateChangelog', settings.updateChangelog, DEFAULT_CONFIG.updateChangelog),
    autoMergeOnGreen,
    mergeMethod: pickName<MergeMethod>(settings.mergeMethod, MERGE_METHODS, DEFAULT_CONFIG.mergeMethod),
    squashOnMerge,
    completionSound: boolean('completionSound', settings.completionSound, DEFAULT_CONFIG.completionSound),
    review: boolean('review', settings.review, DEFAULT_CONFIG.review),
    // stringOr, not `||`: an explicit "" is the documented escape hatch for
    // "let the agent CLI pick", and must not fall through to the named default.
    reviewModel: stringOr(str(settings.reviewModel), defaultReviewModel(agent)),
    reviewMinSeverity: pickSeverity(settings.reviewMinSeverity, DEFAULT_CONFIG.reviewMinSeverity),
    reviewMaxComments: positiveNumber(settings.reviewMaxComments, DEFAULT_CONFIG.reviewMaxComments),
    reviewChunkChars: positiveNumber(settings.reviewChunkChars, DEFAULT_CONFIG.reviewChunkChars),
    // 0 is meaningful here ("decide from the agent"), so it cannot go through positiveNumber.
    reviewFilesPerTurn: nonNegativeNumber(settings.reviewFilesPerTurn, DEFAULT_CONFIG.reviewFilesPerTurn),
    switchToFeatureBranch: boolean('switchToFeatureBranch', settings.switchToFeatureBranch, DEFAULT_CONFIG.switchToFeatureBranch),
    plainOutput: boolean('plainOutput', settings.plainOutput, DEFAULT_CONFIG.plainOutput),
  };
}
