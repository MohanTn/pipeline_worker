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
}
