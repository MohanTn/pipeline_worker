/**
 * Forge-neutral client interface. "MR" naming follows GitLab; the GitHub
 * implementation maps pull requests / workflow runs / jobs onto the same
 * shapes so the workflow and MCP server never branch on the forge.
 */

import type { MergeMethod, MergeRequest, Pipeline, PipelineJob } from '../types.js';

export interface CreateMrArgs {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export interface MrDescription {
  text: string;
  version?: string;
}

/** One line-anchored review comment (see ForgeClient.createInlineComment). */
export interface InlineComment {
  /** Repo-relative path as it appears on the diff's *new* side. */
  path: string;
  /**
   * Line number in the file's NEW version. Both forges only accept a line
   * that is part of the diff, and an *added* line is the only kind this
   * feature anchors to — GitLab's position needs old_line as well for an
   * unchanged line (see review/types.ts's DiffChunk.commentableLines).
   */
  line: number;
  body: string;
}

export interface ForgeClient {
  /** Idempotency check: finds an already-open MR/PR for this branch, if any. */
  findExistingMr(sourceBranch: string): Promise<MergeRequest | undefined>;
  createMergeRequest(args: CreateMrArgs): Promise<MergeRequest>;
  /** Overwrites an existing MR/PR's description — used by `resume`'s branch-adoption path to refresh it with newly captured intent. Throws ConflictError when version doesn't match (concurrent edit detected). */
  updateMrDescription(mrIid: number, description: string, version?: string): Promise<void>;
  /** The MR/PR's current description with its version, '' when it has none — read before appending a follow-up run's section so nothing already written there is lost. */
  getMrDescription(mrIid: number): Promise<MrDescription>;
  /** Latest-first pipelines (GitHub: workflow runs aggregated into one) for an MR/PR. */
  getMrPipelines(mrIid: number): Promise<Pipeline[]>;
  getFailedJobs(pipelineId: number): Promise<PipelineJob[]>;
  getJobLog(jobId: number): Promise<string>;
  retryPipeline(pipelineId: number): Promise<Pipeline>;
  createMrNote(mrIid: number, body: string): Promise<{ id: number }>;
  /**
   * Posts one comment anchored to a line of the MR/PR's diff — GitHub's
   * pull-request review comment (`commit_id` + `path` + `line` on the RIGHT
   * side), GitLab's discussion with a `text` position. Both forges reject a
   * line that isn't part of the diff, and both reject a position computed
   * against a commit the branch has since moved past, so this throws far more
   * readily than createMrNote: every caller treats a rejection as
   * best-effort (a note, not a failed run) — see workflow/reviewMergeRequest.ts.
   */
  createInlineComment(mrIid: number, comment: InlineComment): Promise<{ id: number }>;
  /**
   * True only when the forge has *confirmed* the MR/PR has real merge
   * conflicts against its target branch (GitHub's `mergeable_state: "dirty"`,
   * GitLab's `merge_status: "cannot_be_merged"`). Both forges compute this
   * asynchronously after a push, so a not-yet-known state must read as
   * false here — treating "unknown" as "conflicted" would trigger conflict
   * resolution on every push, before the forge has even checked.
   */
  hasMergeConflicts(mrIid: number): Promise<boolean>;
  /**
   * Asks the forge to merge this MR/PR automatically once CI (and any
   * required approvals) allow it — GitHub's `enablePullRequestAutoMerge`
   * GraphQL mutation, GitLab's `merge_when_pipeline_succeeds`. Throws on
   * rejection (e.g. the forge's auto-merge feature isn't enabled for this
   * repo, or approvals are still pending); the caller treats this as
   * best-effort and must not let a rejection fail the run.
   */
  enableAutoMerge(mrIid: number, mergeMethod: MergeMethod): Promise<void>;
  /**
   * True once the forge reports the MR/PR as actually merged — GitHub's
   * `merged` flag on the pull request, GitLab's `state: "merged"`. Used
   * after enableAutoMerge to detect that the auto-merge really landed, so
   * the local target branch can be fast-forwarded to include it (see
   * workflow/syncTargetBranch.ts). A still-open or closed-unmerged MR/PR
   * reads as false.
   */
  isMrMerged(mrIid: number): Promise<boolean>;
  /**
   * The project's custom CI/CD configuration file path, if one is set
   * (GitLab's "CI/CD configuration file" project setting) — used by
   * watchPipeline.ts's hasCiConfig to recognize CI as configured even when
   * it isn't at the conventional `.gitlab-ci.yml` path. GitHub has no
   * equivalent concept (workflows are always under `.github/workflows`) and
   * always resolves undefined, with no network call.
   */
  getCiConfigPath(): Promise<string | undefined>;
}
