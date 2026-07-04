/** Single source of truth for pipeline-worker's cross-module data shapes. */

export type AgentName = 'claude' | 'copilot';
export type ForgeName = 'gitlab' | 'github';

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
  /** Once the MR/PR is opened and CI is green, reset repoRoot to HEAD — the captured changes now live safely on the branch. */
  cleanupOnSuccess: boolean;
  /** Run the local lint and test stages before opening the MR/PR; false runs only build, skipping both — e.g. when an earlier workflow already verified them. */
  runLintAndTest: boolean;
}

export type RunPhase = 'diff' | 'intent' | 'checks' | 'mr' | 'watch' | 'done' | 'escalated';

/** One entry in RunState.history — a timestamped narration of what happened during the run, for `pipeline-worker sessions`. */
export interface RunHistoryEntry {
  at: string; // ISO 8601
  phase: RunPhase;
  level: 'info' | 'error';
  message: string;
}

export interface RunState {
  branch: string;
  targetBranch: string;
  worktreePath: string;
  mrIid?: number;
  pipelineId?: number;
  attempt: number;
  phase: RunPhase;
  /** ISO 8601 timestamp of when this run was first created. Absent on state files written before this field existed. */
  startedAt?: string;
  /** ISO 8601 timestamp of the most recent state write. Absent on state files written before this field existed. */
  updatedAt?: string;
  /** Chronological log of phase transitions, escalations, and errors. Absent on state files written before this field existed. */
  history?: RunHistoryEntry[];
}

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
