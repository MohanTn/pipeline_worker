/**
 * GitLab ForgeClient. Talks to GitLab by invoking the `glab` CLI (`glab api
 * ...`): auth is passed via a GITLAB_TOKEN in the child process's env and the
 * target instance via `--hostname`, so glab resolves the request itself. The
 * token is deliberately sourced only from an environment variable and never
 * logged. Used both by the workflow orchestrator and the MCP tool handlers,
 * so there is exactly one place that knows how to talk to GitLab.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergeMethod, PipelineWorkerConfig, MergeRequest, Pipeline, PipelineJob } from '../types.js';
import type { CreateMrArgs, ForgeClient } from './types.js';
import { firstOrUndefined, isRetryableStatus } from './shared.js';
import { writePromptToStdin } from '../agent/stdinPrompt.js';

const execFileAsync = promisify(execFile);

interface GlabAuth {
  hostname: string;
  projectId: number | string;
  token: string;
}

/** `--hostname` takes a bare host[:port], not a URL — strip the scheme the rest of the config carries. */
function bareHostname(host: string): string {
  try {
    return new URL(host).host;
  } catch {
    return host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
  }
}

function resolveGitlabAuth(config: PipelineWorkerConfig): GlabAuth {
  // config.gitlab.host/projectId are already env/.env-resolved by
  // config/loader.ts; the token is read directly from the environment here.
  const host = config.gitlab.host;
  const projectId = config.gitlab.projectId;
  const token = process.env.PIPELINE_WORKER_GITLAB_TOKEN;

  if (!host) throw new Error('GitLab host is not configured (set PIPELINE_WORKER_GITLAB_HOST).');
  if (!projectId) throw new Error('GitLab projectId is not configured (set PIPELINE_WORKER_GITLAB_PROJECT_ID, or PIPELINE_WORKER_GITLAB_REPO_BASE for auto-detection).');
  if (!token) throw new Error('PIPELINE_WORKER_GITLAB_TOKEN environment variable is not set.');

  return { hostname: bareHostname(host), projectId, token };
}

/** Runs one `glab` invocation and resolves with stdout, or throws a plain Error with glab's stderr on a non-zero exit. Injectable so tests never need a real `glab` binary. */
export type GlabExecutor = (args: string[], input?: string) => Promise<string>;

/** Subset of the rejection shape Node's promisified execFile produces. */
interface ExecErrorShape {
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

function createGlabExecutor(token: string): GlabExecutor {
  return async (args, input) => {
    try {
      const invocation = execFileAsync('glab', args, {
        env: { ...process.env, GITLAB_TOKEN: token },
        maxBuffer: 64 * 1024 * 1024,
      });
      // stdin is always a pipe here since stdio isn't overridden in execFileAsync's options.
      if (input !== undefined) writePromptToStdin(invocation.child.stdin!, input);
      const { stdout } = await invocation;
      return stdout;
    } catch (rawErr) {
      const err = rawErr as ExecErrorShape;
      if (err.code === 'ENOENT') {
        throw new Error('glab CLI not found on PATH (required for PIPELINE_WORKER_FORGE=gitlab).');
      }
      throw new Error((err.stderr && err.stderr.trim()) || err.message || String(rawErr));
    }
  };
}

const RETRY_CFG = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8000 };
const STATUS_IN_MESSAGE = /\b([1-5]\d{2})\b/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a glab invocation on a 429/5xx reported in its error message —
 * mirrors forgeFetch's tolerance for transient forge-side blips over a long
 * CI-watch poll loop. glab doesn't expose a structured status code on
 * failure, so retryability is sniffed from the first 3-digit number in the
 * thrown message; a message with none (e.g. glab missing, DNS failure) is
 * treated as non-retryable rather than guessed at.
 */
async function withGitlabRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const match = message.match(STATUS_IN_MESSAGE);
      const retryable = match !== null && isRetryableStatus(Number(match[1]));
      if (!retryable || attempt >= RETRY_CFG.maxRetries) {
        throw new Error(`${label} failed: ${message}`);
      }
      await sleep(Math.random() * Math.min(RETRY_CFG.maxDelayMs, RETRY_CFG.baseDelayMs * 2 ** attempt));
    }
  }
}

/** Builds a path relative to /api/v4 (glab prepends that itself) for this project, e.g. `/merge_requests?...`. */
function projectPath(auth: GlabAuth, suffix = ''): string {
  const projectSegment = typeof auth.projectId === 'string' ? encodeURIComponent(auth.projectId) : auth.projectId;
  return `projects/${projectSegment}${suffix}`;
}

async function apiGet(exec: GlabExecutor, auth: GlabAuth, label: string, path: string): Promise<any> {
  const stdout = await withGitlabRetry(label, () => exec(['api', path, '--hostname', auth.hostname]));
  return JSON.parse(stdout);
}

async function apiText(exec: GlabExecutor, auth: GlabAuth, label: string, path: string): Promise<string> {
  return withGitlabRetry(label, () => exec(['api', path, '--hostname', auth.hostname]));
}

async function apiWrite(exec: GlabExecutor, auth: GlabAuth, label: string, method: 'POST' | 'PUT', path: string, body?: object): Promise<any> {
  const args = ['api', path, '-X', method, '--hostname', auth.hostname];
  // GitLab (Grape) returns 415 when Content-Type declares JSON but the
  // request has no body, so `--input -` (and hence a JSON body) is only
  // passed when a body is actually sent.
  const input = body === undefined ? undefined : JSON.stringify(body);
  if (input !== undefined) args.push('--input', '-');
  const stdout = await withGitlabRetry(label, () => exec(args, input));
  return stdout ? JSON.parse(stdout) : undefined;
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

export function createGitlabForge(config: PipelineWorkerConfig, executor?: GlabExecutor): ForgeClient {
  const auth = resolveGitlabAuth(config);
  const exec = executor ?? createGlabExecutor(auth.token);

  return {
    async findExistingMr(sourceBranch: string): Promise<MergeRequest | undefined> {
      const list = await apiGet(
        exec,
        auth,
        'GitLab API GET merge_requests',
        projectPath(auth, `/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&state=opened`),
      );
      return firstOrUndefined(list, toMergeRequest);
    },

    async createMergeRequest(args: CreateMrArgs): Promise<MergeRequest> {
      const raw = await apiWrite(exec, auth, 'GitLab API POST merge_requests', 'POST', projectPath(auth, '/merge_requests'), {
        source_branch: args.sourceBranch,
        target_branch: args.targetBranch,
        title: args.title,
        description: args.description,
      });
      return toMergeRequest(raw);
    },

    async updateMrDescription(mrIid: number, description: string): Promise<void> {
      await apiWrite(exec, auth, `GitLab API PUT merge_requests/${mrIid}`, 'PUT', projectPath(auth, `/merge_requests/${mrIid}`), { description });
    },

    async getMrPipelines(mrIid: number): Promise<Pipeline[]> {
      const list = await apiGet(exec, auth, `GitLab API GET merge_requests/${mrIid}/pipelines`, projectPath(auth, `/merge_requests/${mrIid}/pipelines`));
      return list.map(toPipeline);
    },

    async getFailedJobs(pipelineId: number): Promise<PipelineJob[]> {
      const list = await apiGet(exec, auth, `GitLab API GET pipelines/${pipelineId}/jobs`, projectPath(auth, `/pipelines/${pipelineId}/jobs?scope[]=failed`));
      return list.map(toPipelineJob);
    },

    async getJobLog(jobId: number): Promise<string> {
      return apiText(exec, auth, `GitLab API GET jobs/${jobId}/trace`, projectPath(auth, `/jobs/${jobId}/trace`));
    },

    async retryPipeline(pipelineId: number): Promise<Pipeline> {
      const raw = await apiWrite(exec, auth, `GitLab API POST pipelines/${pipelineId}/retry`, 'POST', projectPath(auth, `/pipelines/${pipelineId}/retry`));
      return toPipeline(raw);
    },

    async createMrNote(mrIid: number, body: string): Promise<{ id: number }> {
      const raw = await apiWrite(exec, auth, `GitLab API POST merge_requests/${mrIid}/notes`, 'POST', projectPath(auth, `/merge_requests/${mrIid}/notes`), { body });
      return { id: raw.id };
    },

    async hasMergeConflicts(mrIid: number): Promise<boolean> {
      const mr = await apiGet(exec, auth, `GitLab API GET merge_requests/${mrIid}`, projectPath(auth, `/merge_requests/${mrIid}`));
      // "cannot_be_merged" is GitLab's confirmed-conflict state; "unchecked"/
      // "checking"/"cannot_be_merged_recheck" mean it hasn't finished
      // computing yet and must not be treated as a conflict.
      return mr.merge_status === 'cannot_be_merged';
    },

    async isMrMerged(mrIid: number): Promise<boolean> {
      const mr = await apiGet(exec, auth, `GitLab API GET merge_requests/${mrIid}`, projectPath(auth, `/merge_requests/${mrIid}`));
      // "merged" is a distinct state from "closed" (closed-without-merging)
      // on GitLab, so the state field alone is authoritative here.
      return mr.state === 'merged';
    },

    async enableAutoMerge(mrIid: number, mergeMethod: MergeMethod): Promise<void> {
      // GitLab has no per-request "rebase" option on this endpoint — merge
      // strategy besides squash-or-not is a project-level setting, so
      // mergeMethod: 'rebase' here silently falls back to the project's own
      // default merge method (documented on ForgeClient.enableAutoMerge).
      await apiWrite(exec, auth, `GitLab API PUT merge_requests/${mrIid}/merge`, 'PUT', projectPath(auth, `/merge_requests/${mrIid}/merge`), {
        merge_when_pipeline_succeeds: true,
        squash: mergeMethod === 'squash',
      });
    },

    async getCiConfigPath(): Promise<string | undefined> {
      const project = await apiGet(exec, auth, 'GitLab API GET project', projectPath(auth));
      // Absent/null/empty all mean "using the default .gitlab-ci.yml path" —
      // treat them identically rather than betting on one exact representation.
      return project.ci_config_path || undefined;
    },
  };
}
