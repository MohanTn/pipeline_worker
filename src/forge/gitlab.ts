/**
 * GitLab REST (v4) ForgeClient. The token is deliberately sourced only from
 * an environment variable — it must never live in `.pipeline-worker.yml` or be
 * logged. Used both by the workflow orchestrator and the MCP tool handlers,
 * so there is exactly one place that knows how to talk to GitLab.
 */

import type { PipelineWorkerConfig, MergeRequest, Pipeline, PipelineJob } from '../types.js';
import type { CreateMrArgs, ForgeClient } from './types.js';

export interface GitlabAuth {
  host: string;
  projectId: number;
  token: string;
}

export function resolveGitlabAuth(config: PipelineWorkerConfig): GitlabAuth {
  const host = process.env.PIPELINE_WORKER_GITLAB_HOST || config.gitlab.host;
  const projectIdEnv = process.env.PIPELINE_WORKER_GITLAB_PROJECT_ID;
  const projectId = projectIdEnv ? Number(projectIdEnv) : config.gitlab.projectId;
  const token = process.env.PIPELINE_WORKER_GITLAB_TOKEN;

  if (!host) throw new Error('GitLab host is not configured (set gitlab.host in .pipeline-worker.yml or PIPELINE_WORKER_GITLAB_HOST).');
  if (!projectId) throw new Error('GitLab projectId is not configured (set gitlab.projectId in .pipeline-worker.yml or PIPELINE_WORKER_GITLAB_PROJECT_ID).');
  if (!token) throw new Error('PIPELINE_WORKER_GITLAB_TOKEN environment variable is not set.');

  return { host, projectId, token };
}

async function gitlabRequest(auth: GitlabAuth, path: string, init?: RequestInit): Promise<Response> {
  const url = `${auth.host.replace(/\/$/, '')}/api/v4/projects/${auth.projectId}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'PRIVATE-TOKEN': auth.token,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitLab API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText} — ${body}`);
  }
  return res;
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
      return list.length > 0 ? toMergeRequest(list[0]) : undefined;
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
      const note = (await res.json()) as { id: number };
      return { id: note.id };
    },
  };
}
