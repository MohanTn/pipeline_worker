/** Single source of truth for pipeline-worker's cross-module data shapes. */

export type AgentName = 'claude' | 'copilot' | 'pi';
export type ForgeName = 'gitlab' | 'github';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PipelineWorkerConfig {
  agent: AgentName;
  forge: ForgeName;
  gitlab: {
    host: string;
    projectId: number | string;
    repoBase?: string; // optional local directory that mirrors the GitLab host root, for auto-detecting projectId
  };
  github: {
    /** "owner/name" slug of the repository. */
    repo: string;
  };
  /** Check commands; defaults are auto-detected per toolchain, '' skips the stage. */
  build: string;
  lint: string;
  test: string;
  maxFixAttempts: number;
  pollIntervalSeconds: number;
  /** Model passed to the agent for the intent-capture step (see captureIntent.ts). Ignored by adapters with no per-invocation model selection (e.g. copilot). */
  intentModel: string;
  /** Feature branch naming template. Supports {type}, {ticket}, {name} placeholders; e.g. "{type}/{ticket}/{name}". */
  branchPattern: string;
  /** Once cleanup fires (see cleanupEarly for when), reset repoRoot to HEAD — the captured changes now live safely on the branch. */
  cleanupOnSuccess: boolean;
  /** If true, cleanup fires as soon as the MR/PR is opened (diff is committed + pushed) instead of waiting for CI to go green — lets repoRoot be reused for a new run immediately while this run's CI-watch/fix loop keeps going independently. */
  cleanupEarly: boolean;
  /** Run the local lint and test stages before opening the MR/PR; false runs only build, skipping both — e.g. when an earlier workflow already verified them. */
  runLintAndTest: boolean;
  /** Once checks pass, add a bullet for this change under CHANGELOG.md's [Unreleased] section (creating the file if absent) and include it in the commit. Off by default: not every consuming repo keeps a changelog. */
  updateChangelog: boolean;
  /** Once the MR/PR opens, ask the forge to merge it automatically as soon as CI (and any required approvals) allow — best-effort, never fails the run if the forge rejects it. Off by default: merging is a policy decision, not something to turn on silently. */
  autoMergeOnGreen: boolean;
  /** Merge strategy passed to enableAutoMerge. Defaults to 'squash'. GitLab has no per-request rebase option — 'rebase' there silently falls back to the project's own default merge method. */
  mergeMethod: MergeMethod;
  /**
   * Once CI is green, collapse every commit this run made on the branch
   * since it diverged from targetBranch into one (titled from the captured
   * intent) and force-push — keeps history clean regardless of the target
   * repo's merge-strategy setting. Off by default: unlike every other write
   * this tool makes, this rewrites already-pushed history (force-push), a
   * materially different risk. Only reliable with autoMergeOnGreen off — the
   * forge may already have merged (and deleted) the branch before this runs.
   */
  squashOnMerge: boolean;
}

export type RunPhase = 'diff' | 'intent' | 'checks' | 'mr' | 'watch' | 'done' | 'escalated';

/** One entry in RunState.history — a timestamped narration of what happened during the run, for `pipeline-worker sessions`. */
export interface RunHistoryEntry {
  at: string; // ISO 8601
  phase: RunPhase;
  level: 'info' | 'error';
  message: string;
  /** Agent tokens spent by the turn this entry narrates. Absent when the adapter reports no usage (pi/copilot) or the entry isn't an agent turn. */
  tokens?: number;
}

export interface RunState {
  branch: string;
  targetBranch: string;
  worktreePath: string;
  mrIid?: number;
  pipelineId?: number;
  /** Automated-fix attempts spent on a real CI failure (watchPipeline.ts's runCiFixAttempt); bounded by config.maxFixAttempts independently of conflictAttempt. */
  ciFixAttempt: number;
  /** Automated-fix attempts spent resolving merge conflicts with the target branch (watchPipeline.ts's tryResolveConflicts); bounded by config.maxFixAttempts independently of ciFixAttempt, so a long-lived PR needing several trivial rebases can't exhaust the budget meant for real bug-fixing. */
  conflictAttempt: number;
  phase: RunPhase;
  /** Running sum of every history entry's `tokens` — the run's total agent spend, as far as the adapter reports it. Absent on state files written before this field existed and on runs whose adapter reports no usage. */
  totalTokens?: number;
  /** ISO 8601 timestamp of when this run was first created. Absent on state files written before this field existed. */
  startedAt?: string;
  /** ISO 8601 timestamp of the most recent state write. Absent on state files written before this field existed. */
  updatedAt?: string;
  /** Chronological log of phase transitions, escalations, and errors. Absent on state files written before this field existed. */
  history?: RunHistoryEntry[];
}

/** RunState with mrIid narrowed to present — the shape `pipeline-worker resume` operates on, once an MR/PR is known to exist. */
export type ResumableRunState = RunState & { mrIid: number };

export type RiskLevel = 'low' | 'medium' | 'high';
export type ChangeType = 'feature' | 'bugfix' | 'chore';

export interface FileChangeSummary {
  file: string;
  summary: string;
}

export interface CapturedIntent {
  /** One short sentence: why this change exists / what problem it solves. */
  intent: string;
  summary: string;
  changeType: ChangeType;
  /** Short kebab-case slug describing the change, with no prefix/ticket — the branch pattern supplies those. */
  branchSlug: string;
  commitMessage: string;
  fileChanges: FileChangeSummary[];
  risk: RiskLevel;
  /** One short sentence justifying the risk level. */
  riskReason: string;
  /** Concrete scenarios a reviewer should verify before merging. */
  testScenarios: string[];
}

export interface CheckResult {
  name: 'build' | 'lint' | 'test';
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface MergeRequest {
  iid: number;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
}

export type PipelineStatus =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled';

export interface Pipeline {
  id: number;
  status: PipelineStatus;
  webUrl: string;
}

export interface PipelineJob {
  id: number;
  name: string;
  stage: string;
}
