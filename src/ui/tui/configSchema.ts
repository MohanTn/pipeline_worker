/**
 * The user-facing description of every settings key: what it is called, what
 * kind of value it takes, and — the part that makes the TUI a setup guide
 * rather than a JSON editor with arrow keys — one short paragraph explaining
 * what it changes and when you would touch it.
 *
 * This is the single schema behind both the settings editor and the setup
 * wizard. Defaults are read from config/loader.ts's DEFAULT_CONFIG rather than
 * restated here, so there is exactly one copy of "what pipeline-worker does
 * when you configure nothing".
 */

import { DEFAULT_CONFIG } from '../../config/loader.js';
import { getAtPath, type ConfigValue } from './configStore.js';
import type { PipelineWorkerConfig } from '../../types.js';

export type FieldKind = 'boolean' | 'enum' | 'number' | 'string' | 'secret';

export interface ConfigField {
  /** Dotted path into both the settings file and a resolved PipelineWorkerConfig. */
  path: string;
  label: string;
  group: string;
  kind: FieldKind;
  doc: string;
  choices?: readonly string[];
  /**
   * True when an unset key is filled in from the repo rather than from a
   * built-in default (build/lint/test from the toolchain, github.repo from
   * `origin`, gitlab.projectId from repoBase) — which is what lets the editor
   * label a value 'auto' instead of misreporting it as 'default'.
   */
  autoDetected?: boolean;
  /** Shown in place of an empty value, e.g. '(auto-detected)'. */
  placeholder?: string;
}

export const CONFIG_GROUPS = ['Agent & forge', 'GitLab', 'GitHub', 'Checks', 'Merge & cleanup', 'Review', 'Output', 'little-coder'] as const;

export const CONFIG_FIELDS: readonly ConfigField[] = [
  {
    path: 'agent',
    label: 'agent',
    group: 'Agent & forge',
    kind: 'enum',
    choices: ['claude', 'copilot', 'pi', 'little-coder'],
    doc: 'Which coding-agent CLI runs the intent capture, CI fixes, conflict resolution, and reviews. The binary must be installed and on PATH. "little-coder" is pi tuned for small local models.',
  },
  {
    path: 'forge',
    label: 'forge',
    group: 'Agent & forge',
    kind: 'enum',
    choices: ['gitlab', 'github'],
    doc: 'Where merge/pull requests are opened. "gitlab" drives the `glab` CLI (it must be installed); "github" calls the REST API directly with a token.',
  },
  {
    path: 'intentModel',
    label: 'intentModel',
    group: 'Agent & forge',
    kind: 'string',
    doc: 'Model used for the cheap intent-capture turn that summarizes your diff and names the branch. A small/fast model is the right choice here. Ignored by copilot, which has no per-invocation model selection.',
  },
  {
    path: 'bareAgentMode',
    label: 'bareAgentMode',
    group: 'Agent & forge',
    kind: 'boolean',
    doc: 'Run every agent turn as lean as the CLI allows (for claude: --bare, no hooks/plugins/CLAUDE.md). Turn this OFF if you sign in to claude with a subscription rather than an API key — --bare reads credentials only from ANTHROPIC_API_KEY, so every turn would fail to authenticate.',
  },
  {
    path: 'branchPattern',
    label: 'branchPattern',
    group: 'Agent & forge',
    kind: 'string',
    doc: 'Template for the feature branch name. Placeholders: {name} (a slug from your change), {type} (feature/bugfix/chore), {ticket} (whatever you pass to --ticket).',
  },
  {
    path: 'maxFixAttempts',
    label: 'maxFixAttempts',
    group: 'Agent & forge',
    kind: 'number',
    doc: 'How many automated attempts the agent gets at a red pipeline before the run escalates to you. Merge-conflict attempts get this same budget separately.',
  },
  {
    path: 'pollIntervalSeconds',
    label: 'pollIntervalSeconds',
    group: 'Agent & forge',
    kind: 'number',
    doc: 'Seconds between CI status polls while watching a pipeline. Lower means faster reaction and more API calls.',
  },

  {
    path: 'gitlab.host',
    label: 'host',
    group: 'GitLab',
    kind: 'string',
    placeholder: '(required for gitlab)',
    doc: 'Your GitLab base URL, e.g. https://gitlab.com or your self-hosted instance. Passed to `glab` as --hostname.',
  },
  {
    path: 'gitlab.projectId',
    label: 'projectId',
    group: 'GitLab',
    kind: 'string',
    autoDetected: true,
    placeholder: '(auto-detected from repoBase)',
    doc: 'Numeric project id, or a "group/subgroup/project" path. Left unset, it is derived from repoBase plus the repo\'s location on disk.',
  },
  {
    path: 'gitlab.repoBase',
    label: 'repoBase',
    group: 'GitLab',
    kind: 'string',
    placeholder: '(unset)',
    doc: 'A local directory that mirrors your GitLab group structure, e.g. ~/work/gitlab. Set it once and every repo underneath resolves its own project path automatically, instead of you setting projectId per repo.',
  },
  {
    path: 'gitlab.token',
    label: 'token',
    group: 'GitLab',
    kind: 'secret',
    placeholder: '(required for gitlab)',
    doc: 'GitLab personal access token with api scope, passed to `glab` as GITLAB_TOKEN. Stored in your config file and never logged.',
  },

  {
    path: 'github.repo',
    label: 'repo',
    group: 'GitHub',
    kind: 'string',
    autoDetected: true,
    placeholder: '(auto-detected from origin)',
    doc: 'The "owner/name" slug. Left unset, it is read from the repo\'s own `origin` remote, which is right nearly always.',
  },
  {
    path: 'github.token',
    label: 'token',
    group: 'GitHub',
    kind: 'secret',
    placeholder: '(required for github)',
    doc: 'GitHub token with repo scope, sent as the Bearer credential. Stored in your config file and never logged.',
  },
  {
    path: 'github.apiUrl',
    label: 'apiUrl',
    group: 'GitHub',
    kind: 'string',
    doc: 'REST API base URL. Change it only for GitHub Enterprise, e.g. https://github.example.com/api/v3.',
  },

  {
    path: 'build',
    label: 'build',
    group: 'Checks',
    kind: 'string',
    autoDetected: true,
    placeholder: '(auto-detected)',
    doc: 'Command run to verify the change before the MR/PR opens. Auto-detected from your toolchain. Set it to an empty value to skip the stage entirely.',
  },
  {
    path: 'lint',
    label: 'lint',
    group: 'Checks',
    kind: 'string',
    autoDetected: true,
    placeholder: '(auto-detected)',
    doc: 'Lint command. Auto-detected from your toolchain; empty skips the stage.',
  },
  {
    path: 'test',
    label: 'test',
    group: 'Checks',
    kind: 'string',
    autoDetected: true,
    placeholder: '(auto-detected)',
    doc: 'Test command. Auto-detected from your toolchain; empty skips the stage.',
  },
  {
    path: 'runLintAndTest',
    label: 'runLintAndTest',
    group: 'Checks',
    kind: 'boolean',
    doc: 'Run lint and test locally before opening the MR/PR. Turn it off to run build only — e.g. when another workflow already verified them, or when your test suite is too slow to sit through.',
  },

  {
    path: 'autoMergeOnGreen',
    label: 'autoMergeOnGreen',
    group: 'Merge & cleanup',
    kind: 'boolean',
    doc: 'Ask the forge to merge the MR/PR as soon as CI and any required approvals allow. Best-effort — it never fails the run. Turn it off if merging is a human decision in your team.',
  },
  {
    path: 'mergeMethod',
    label: 'mergeMethod',
    group: 'Merge & cleanup',
    kind: 'enum',
    choices: ['merge', 'squash', 'rebase'],
    doc: 'Strategy used for auto-merge. GitLab has no per-request rebase option, so "rebase" there falls back to the project\'s own default.',
  },
  {
    path: 'squashOnMerge',
    label: 'squashOnMerge',
    group: 'Merge & cleanup',
    kind: 'boolean',
    doc: 'Collapse the run\'s commits into one and force-push once CI is green. This rewrites already-pushed history, and it races autoMergeOnGreen (the forge may have merged the branch first), so it is only reliable with auto-merge off.',
  },
  {
    path: 'cleanupOnSuccess',
    label: 'cleanupOnSuccess',
    group: 'Merge & cleanup',
    kind: 'boolean',
    doc: 'Reset your working repo to HEAD once the change is safely on the branch. Off leaves your uncommitted diff in place as well as on the branch.',
  },
  {
    path: 'cleanupEarly',
    label: 'cleanupEarly',
    group: 'Merge & cleanup',
    kind: 'boolean',
    doc: 'Clean up as soon as the MR/PR is open, rather than waiting for green CI — so you can start the next change immediately while this run keeps watching and fixing in the background.',
  },
  {
    path: 'switchToFeatureBranch',
    label: 'switchToFeatureBranch',
    group: 'Merge & cleanup',
    kind: 'boolean',
    doc: 'Leave you checked out on the feature branch when the run settles, so your next edit becomes a follow-up commit on the same MR/PR instead of a new one.',
  },
  {
    path: 'updateChangelog',
    label: 'updateChangelog',
    group: 'Merge & cleanup',
    kind: 'boolean',
    doc: 'Add a bullet for the change under CHANGELOG.md\'s [Unreleased] section and include it in the commit. Off by default because not every repo keeps a changelog.',
  },

  {
    path: 'review',
    label: 'review',
    group: 'Review',
    kind: 'boolean',
    doc: 'After the MR/PR opens, have the agent review its own diff and post line-anchored comments. Costs agent tokens and writes where humans read, so it is opt-in. `pipeline-worker review --branch X` runs it regardless of this setting.',
  },
  {
    path: 'reviewModel',
    label: 'reviewModel',
    group: 'Review',
    kind: 'string',
    placeholder: 'sonnet',
    doc: 'Model for review turns, passed to the agent CLI as-is. Defaults to sonnet on claude/copilot — finding real bugs is deliberately not the cheap-model job, so this should be stronger than intentModel. Empty means "let the agent CLI pick", which is what pi and little-coder get (they take a provider/id, not an alias); note the CLI picks its newest model, which an OAuth sign-in may not be able to reach.',
  },
  {
    path: 'reviewMinSeverity',
    label: 'reviewMinSeverity',
    group: 'Review',
    kind: 'enum',
    choices: ['CRITICAL', 'MAJOR', 'MINOR'],
    doc: 'Findings below this severity are never posted. The anti-alert-fatigue gate: raise it to CRITICAL if reviews feel noisy.',
  },
  {
    path: 'reviewMaxComments',
    label: 'reviewMaxComments',
    group: 'Review',
    kind: 'number',
    doc: 'Hard cap on comments one run may post, no matter how much the agent finds.',
  },
  {
    path: 'reviewChunkChars',
    label: 'reviewChunkChars',
    group: 'Review',
    kind: 'number',
    doc: 'Characters of diff carried by one review turn. The default fits a whole normal MR/PR in a single agent session; lower it for a small local model.',
  },
  {
    path: 'reviewFilesPerTurn',
    label: 'reviewFilesPerTurn',
    group: 'Review',
    kind: 'number',
    doc: 'Files one review turn may cover. 0 means "decide from the agent": everything at once for a cloud model, a few files at a time for little-coder.',
  },

  {
    path: 'completionSound',
    label: 'completionSound',
    group: 'Output',
    kind: 'boolean',
    doc: 'Play a soft notification sound when a run settles, so an unattended run can tell you it is done. Silently skipped when no audio player is available.',
  },
  {
    path: 'plainOutput',
    label: 'plainOutput',
    group: 'Output',
    kind: 'boolean',
    doc: 'Force the append-only narration instead of the live redrawing step tree, even on a real terminal. Useful when filing a bug report or piping run output through grep.',
  },

  {
    path: 'littleCoder.binary',
    label: 'binary',
    group: 'little-coder',
    kind: 'string',
    doc: 'Binary name or absolute path for the little-coder CLI. Only read when agent is "little-coder".',
  },
  {
    path: 'littleCoder.maxPromptChars',
    label: 'maxPromptChars',
    group: 'little-coder',
    kind: 'number',
    doc: 'Hard cap on one prompt\'s characters, so a small local model with a tight context window is never overrun; longer prompts are truncated middle-out. 0 disables the cap.',
  },
];

/** The built-in default for a field, or undefined for the auto-detected ones that have none. */
export function defaultValue(field: ConfigField): unknown {
  return getAtPath(DEFAULT_CONFIG as unknown as Record<string, unknown>, field.path);
}

export type ValueSource = 'file' | 'auto' | 'default';

/**
 * Where the value in effect came from: the settings file, repo auto-detection,
 * or the built-in default. Shown next to every row so a user can tell "I chose
 * this" from "this is just what happened to be true today" — the distinction
 * that makes a settings screen trustworthy.
 */
export function valueSource(field: ConfigField, settings: Record<string, unknown>, effective: PipelineWorkerConfig): ValueSource {
  const fromFile = getAtPath(settings, field.path);
  const inForce = getAtPath(effective as unknown as Record<string, unknown>, field.path);
  // "Present in the file" is not enough to claim the file decided it: the
  // loader drops an empty github.repo / gitlab.host in favour of detection, and
  // the first-run file contains every key. Only a file value that survived
  // resolution is really the one in force.
  if (fromFile !== undefined && fromFile === inForce) return 'file';
  if (inForce !== defaultValue(field)) return 'auto';
  return 'default';
}

/** The value actually in force for a field, resolved exactly as the workflow sees it. */
export function effectiveValue(field: ConfigField, effective: PipelineWorkerConfig): unknown {
  return getAtPath(effective as unknown as Record<string, unknown>, field.path);
}

/** How a value is shown in a row: secrets masked, empty values replaced by the field's placeholder. */
export function displayValue(field: ConfigField, value: unknown): string {
  if (field.kind === 'secret') return value ? '••••••••' : (field.placeholder ?? '(unset)');
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  // 0 is a real, meaningful value for several numeric knobs ("unlimited"), so
  // only a genuinely empty string falls back to the placeholder.
  const text = value === undefined || value === null ? '' : String(value);
  return text === '' ? (field.placeholder ?? '(empty)') : text;
}

/**
 * Parses what the user typed into the value the settings file should hold.
 * Returns an error message instead of throwing for anything unusable, so the
 * editor can keep the field open with the reason shown.
 */
export function parseFieldInput(field: ConfigField, input: string): { ok: true; value: ConfigValue } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (field.kind === 'number') {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) return { ok: false, error: 'expected a number of 0 or more' };
    return { ok: true, value: num };
  }
  if (field.kind === 'enum') {
    const match = field.choices?.find((choice) => choice.toLowerCase() === trimmed.toLowerCase());
    if (!match) return { ok: false, error: `expected one of ${field.choices?.join(', ')}` };
    return { ok: true, value: match };
  }
  // Strings and secrets are stored verbatim — an empty string is meaningful
  // for build/lint/test ("skip this stage") and must not be trimmed away into
  // "unset", which would resurrect auto-detection.
  return { ok: true, value: field.kind === 'secret' ? trimmed : input };
}

/** The next value when a field is cycled in place (enter on a boolean or an enum). */
export function cycleValue(field: ConfigField, current: unknown): ConfigValue | undefined {
  if (field.kind === 'boolean') return !current;
  if (field.kind === 'enum' && field.choices && field.choices.length > 0) {
    const index = field.choices.indexOf(String(current));
    return field.choices[(index + 1) % field.choices.length];
  }
  return undefined;
}
