/**
 * GitHub REST ForgeClient. Maps GitHub concepts onto the forge-neutral
 * shapes: pull request -> MergeRequest (iid = PR number), the set of Actions
 * workflow runs for the PR's head SHA -> one aggregated Pipeline, workflow
 * jobs -> PipelineJob. The token is deliberately sourced only from an
 * environment variable and never logged.
 */

import type { PipelineWorkerConfig, MergeRequest, Pipeline, PipelineJob, PipelineStatus } from '../types.js';
import type { CreateMrArgs, ForgeClient } from './types.js';

export interface GithubAuth {
  apiUrl: string;
  /** "owner/name" slug. */
  repo: string;
  token: string;
}

export function resolveGithubAuth(config: PipelineWorkerConfig): GithubAuth {
  // config.github.repo is already env/.env-resolved by config/loader.ts; the
  // token and the API URL override are read directly from the environment here.
  const apiUrl = process.env.PIPELINE_WORKER_GITHUB_API_URL || 'https://api.github.com';
  const repo = config.github.repo;
  const token = process.env.PIPELINE_WORKER_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error('GitHub repo is not configured (set PIPELINE_WORKER_GITHUB_REPO to "owner/name").');
  }
  if (!token) throw new Error('PIPELINE_WORKER_GITHUB_TOKEN (or GITHUB_TOKEN) environment variable is not set.');

  return { apiUrl: apiUrl.replace(/\/$/, ''), repo, token };
}

async function githubRequest(auth: GithubAuth, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${auth.apiUrl}/repos/${auth.repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText} — ${body}`);
  }
  return res;
}

function toMergeRequest(raw: any): MergeRequest {
  return {
    iid: raw.number,
    webUrl: raw.html_url,
    sourceBranch: raw.head.ref,
    targetBranch: raw.base.ref,
    state: raw.state,
  };
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

function runStatus(run: WorkflowRun): PipelineStatus {
  if (run.status !== 'completed') return 'running';
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'cancelled':
    case 'stale':
      return 'canceled';
    case 'skipped':
    case 'neutral':
      return 'skipped';
    default: // failure, timed_out, startup_failure, action_required, …
      return 'failed';
  }
}

/**
 * Collapses all workflow runs for one head SHA into a single Pipeline.
 * Priority: any run still running -> running (wait for the full picture);
 * else any failed -> failed (its id is what getFailedJobs needs); else any
 * canceled -> canceled; else success unless every run was skipped.
 */
export function aggregateRuns(runs: WorkflowRun[]): Pipeline | undefined {
  if (runs.length === 0) return undefined;
  const byStatus = (wanted: PipelineStatus) => runs.find((run) => runStatus(run) === wanted);

  const pick =
    byStatus('running') ?? byStatus('failed') ?? byStatus('canceled') ?? byStatus('success') ?? runs[0];
  return { id: pick.id, status: runStatus(pick), webUrl: pick.html_url };
}

function isFailedConclusion(conclusion: string | null): boolean {
  return conclusion !== null && !['success', 'skipped', 'neutral'].includes(conclusion);
}

export function createGithubForge(config: PipelineWorkerConfig): ForgeClient {
  const auth = resolveGithubAuth(config);
  const owner = auth.repo.split('/')[0];

  return {
    async findExistingMr(sourceBranch: string): Promise<MergeRequest | undefined> {
      const res = await githubRequest(
        auth,
        `/pulls?head=${encodeURIComponent(`${owner}:${sourceBranch}`)}&state=open`,
      );
      const list = (await res.json()) as any[];
      return list.length > 0 ? toMergeRequest(list[0]) : undefined;
    },

    async createMergeRequest(args: CreateMrArgs): Promise<MergeRequest> {
      const res = await githubRequest(auth, '/pulls', {
        method: 'POST',
        body: JSON.stringify({
          title: args.title,
          body: args.description,
          head: args.sourceBranch,
          base: args.targetBranch,
        }),
      });
      return toMergeRequest(await res.json());
    },

    async getMrPipelines(mrIid: number): Promise<Pipeline[]> {
      const prRes = await githubRequest(auth, `/pulls/${mrIid}`);
      const pr = (await prRes.json()) as { head: { sha: string } };
      const runsRes = await githubRequest(auth, `/actions/runs?head_sha=${pr.head.sha}&per_page=100`);
      const { workflow_runs: runs } = (await runsRes.json()) as { workflow_runs: WorkflowRun[] };
      const aggregate = aggregateRuns(runs);
      return aggregate ? [aggregate] : [];
    },

    async getFailedJobs(pipelineId: number): Promise<PipelineJob[]> {
      const res = await githubRequest(auth, `/actions/runs/${pipelineId}/jobs?filter=latest&per_page=100`);
      const { jobs } = (await res.json()) as { jobs: Array<{ id: number; name: string; conclusion: string | null; workflow_name?: string }> };
      return jobs
        .filter((job) => isFailedConclusion(job.conclusion))
        .map((job) => ({ id: job.id, name: job.name, stage: job.workflow_name ?? 'workflow' }));
    },

    async getJobLog(jobId: number): Promise<string> {
      // Redirects to short-lived blob storage; fetch follows it and drops the auth header cross-origin.
      const res = await githubRequest(auth, `/actions/jobs/${jobId}/logs`);
      return res.text();
    },

    async retryPipeline(pipelineId: number): Promise<Pipeline> {
      await githubRequest(auth, `/actions/runs/${pipelineId}/rerun-failed-jobs`, { method: 'POST' });
      const res = await githubRequest(auth, `/actions/runs/${pipelineId}`);
      const run = (await res.json()) as WorkflowRun;
      return { id: run.id, status: runStatus(run), webUrl: run.html_url };
    },

    async createMrNote(mrIid: number, body: string): Promise<{ id: number }> {
      const res = await githubRequest(auth, `/issues/${mrIid}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      const note = (await res.json()) as { id: number };
      return { id: note.id };
    },

    async hasMergeConflicts(mrIid: number): Promise<boolean> {
      const res = await githubRequest(auth, `/pulls/${mrIid}`);
      const pr = (await res.json()) as { mergeable_state?: string };
      // "dirty" is GitHub's specific state for real merge conflicts; other
      // non-mergeable states (unstable, blocked, behind, draft, unknown) are
      // not conflicts and must not trigger conflict resolution.
      return pr.mergeable_state === 'dirty';
    },
  };
}
