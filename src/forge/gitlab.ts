/**
 * GitLab REST (v4) ForgeClient. The token is deliberately sourced only from
 * an environment variable and never logged. Used both by the workflow
 * orchestrator and the MCP tool handlers, so there is exactly one place that
 * knows how to talk to GitLab.
 */

import type { PipelineWorkerConfig, MergeRequest, Pipeline, PipelineJob } from '../types.js';
import type { CreateMrArgs, ForgeClient } from './types.js';
import { forgeFetch, firstOrUndefined, parseIdResponse } from './shared.js';

interface GitlabAuth {
  host: string;
  projectId: number | string;
  token: string;
}

function resolveGitlabAuth(config: PipelineWorkerConfig): GitlabAuth {
  // config.gitlab.host/projectId are already env/.env-resolved by
  // config/loader.ts; the token is read directly from the environment here.
  const host = config.gitlab.host;
  const projectId = config.gitlab.projectId;
  const token = process.env.PIPELINE_WORKER_GITLAB_TOKEN;

  if (!host) throw new Error('GitLab host is not configured (set PIPELINE_WORKER_GITLAB_HOST).');
  if (!projectId) throw new Error('GitLab projectId is not configured (set PIPELINE_WORKER_GITLAB_PROJECT_ID, or PIPELINE_WORKER_GITLAB_REPO_BASE for auto-detection).');
  if (!token) throw new Error('PIPELINE_WORKER_GITLAB_TOKEN environment variable is not set.');

  return { host, projectId, token };
}

async function gitlabRequest(auth: GitlabAuth, path: string, init?: RequestInit): Promise<Response> {
  // String project paths (e.g. 'group/subgroup/project') must be URL-encoded
  // so slashes don't collide with the API route structure.
  const projectSegment = typeof auth.projectId === 'string' ? encodeURIComponent(auth.projectId) : auth.projectId;
  const url = `${auth.host.replace(/\/$/, '')}/api/v4/projects/${projectSegment}${path}`;
  return forgeFetch(
    'GitLab API',
    path,
    url,
    {
      'PRIVATE-TOKEN': auth.token,
      'Content-Type': 'application/json',
    },
    init,
  );
}

function toMergeRequest(raw: any): MergeRequest {
  return {
    iid: raw.iid,
    webUrl: raw.web_url,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    state: raw.state,
  };
}

function toPipeline(raw: any): Pipeline {
  return { id: raw.id, status: raw.status, webUrl: raw.web_url };
}

function toPipelineJob(raw: any): PipelineJob {
  return { id: raw.id, name: raw.name, stage: raw.stage };
}

export function createGitlabForge(config: PipelineWorkerConfig): ForgeClient {
  const auth = resolveGitlabAuth(config);

  return {
    async findExistingMr(sourceBranch: string): Promise<MergeRequest | undefined> {
      const res = await gitlabRequest(
        auth,
        `/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&state=opened`,
      );
      const list = (await res.json()) as any[];
      return firstOrUndefined(list, toMergeRequest);
    },

    async createMergeRequest(args: CreateMrArgs): Promise<MergeRequest> {
      const res = await gitlabRequest(auth, '/merge_requests', {
        method: 'POST',
        body: JSON.stringify({
          source_branch: args.sourceBranch,
          target_branch: args.targetBranch,
          title: args.title,
          description: args.description,
        }),
      });
      return toMergeRequest(await res.json());
    },

    async getMrPipelines(mrIid: number): Promise<Pipeline[]> {
      const res = await gitlabRequest(auth, `/merge_requests/${mrIid}/pipelines`);
      const list = (await res.json()) as any[];
      return list.map(toPipeline);
    },

    async getFailedJobs(pipelineId: number): Promise<PipelineJob[]> {
      const res = await gitlabRequest(auth, `/pipelines/${pipelineId}/jobs?scope[]=failed`);
      const list = (await res.json()) as any[];
      return list.map(toPipelineJob);
    },

    async getJobLog(jobId: number): Promise<string> {
      const res = await gitlabRequest(auth, `/jobs/${jobId}/trace`);
      return res.text();
    },

    async retryPipeline(pipelineId: number): Promise<Pipeline> {
      const res = await gitlabRequest(auth, `/pipelines/${pipelineId}/retry`, { method: 'POST' });
      return toPipeline(await res.json());
    },

    async createMrNote(mrIid: number, body: string): Promise<{ id: number }> {
      const res = await gitlabRequest(auth, `/merge_requests/${mrIid}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      return parseIdResponse(res);
    },

    async hasMergeConflicts(mrIid: number): Promise<boolean> {
      const res = await gitlabRequest(auth, `/merge_requests/${mrIid}`);
      const mr = (await res.json()) as { merge_status?: string };
      // "cannot_be_merged" is GitLab's confirmed-conflict state; "unchecked"/
      // "checking"/"cannot_be_merged_recheck" mean it hasn't finished
      // computing yet and must not be treated as a conflict.
      return mr.merge_status === 'cannot_be_merged';
    },
  };
}