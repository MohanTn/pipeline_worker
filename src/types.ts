/** Single source of truth for pipeline-worker's cross-module data shapes. */

export type AgentName = 'claude' | 'copilot';
export type ForgeName = 'gitlab' | 'github';

export interface PipelineWorkerConfig {
  agent: AgentName;
  forge: ForgeName;
  gitlab: {
    host: string;
    projectId: number;
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
}

export type RunPhase = 'diff' | 'intent' | 'checks' | 'mr' | 'watch' | 'done' | 'escalated';

export interface RunState {
  branch: string;
  targetBranch: string;
  worktreePath: string;
  mrIid?: number;
  pipelineId?: number;
  attempt: number;
  phase: RunPhase;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface FileChangeSummary {
  file: string;
  summary: string;
}

export interface CapturedIntent {
  /** One short sentence: why this change exists / what problem it solves. */
  intent: string;
  summary: string;
  branchName: string;
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
