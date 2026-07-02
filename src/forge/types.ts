/**
 * Forge-neutral client interface. "MR" naming follows GitLab; the GitHub
 * implementation maps pull requests / workflow runs / jobs onto the same
 * shapes so the workflow and MCP server never branch on the forge.
 */

import type { MergeRequest, Pipeline, PipelineJob } from '../types.js';

export interface CreateMrArgs {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface ForgeClient {
  /** Idempotency check: finds an already-open MR/PR for this branch, if any. */
  findExistingMr(sourceBranch: string): Promise<MergeRequest | undefined>;
  createMergeRequest(args: CreateMrArgs): Promise<MergeRequest>;
  /** Latest-first pipelines (GitHub: workflow runs aggregated into one) for an MR/PR. */
  getMrPipelines(mrIid: number): Promise<Pipeline[]>;
  getFailedJobs(pipelineId: number): Promise<PipelineJob[]>;
  getJobLog(jobId: number): Promise<string>;
  retryPipeline(pipelineId: number): Promise<Pipeline>;
  createMrNote(mrIid: number, body: string): Promise<{ id: number }>;
  /**
   * True only when the forge has *confirmed* the MR/PR has real merge
   * conflicts against its target branch (GitHub's `mergeable_state: "dirty"`,
   * GitLab's `merge_status: "cannot_be_merged"`). Both forges compute this
   * asynchronously after a push, so a not-yet-known state must read as
   * false here — treating "unknown" as "conflicted" would trigger conflict
   * resolution on every push, before the forge has even checked.
   */
  hasMergeConflicts(mrIid: number): Promise<boolean>;
}
