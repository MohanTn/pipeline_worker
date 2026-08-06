/**
 * GitLab ForgeClient. Talks to GitLab by invoking the `glab` CLI (`glab api
 * ...`): auth is passed via a GITLAB_TOKEN in the child process's env and the
 * target instance via `--hostname`, so glab resolves the request itself. The
 * token comes from the settings file's `gitlab.token` (see config/file.ts) and
 * is never logged. Used by the workflow orchestrator, so there is exactly one
 * place that knows how to talk to GitLab.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergeMethod, PipelineWorkerConfig, MergeRequest, Pipeline, PipelineJob } from '../types.js';
import type { CreateMrArgs, ForgeClient, InlineComment, MrComment } from './types.js';
import { firstOrUndefined, isRetryableStatus, renderThread } from './shared.js';
import { configFilePath } from '../config/file.js';
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
  // All three are already resolved by config/loader.ts from
  // ~/.config/pipeline-worker/config.json (projectId may have been derived
  // from gitlab.repoBase there).
  const { host, projectId, token } = config.gitlab;

  if (!host) throw new Error(`GitLab host is not configured (set "gitlab": { "host": "..." } in ${configFilePath()}).`);
  if (!projectId) throw new Error(`GitLab projectId is not configured (set "gitlab": { "projectId": ... }, or "repoBase" for auto-detection, in ${configFilePath()}).`);
  if (!token) throw new Error(`GitLab token is not configured (set "gitlab": { "token": "..." } in ${configFilePath()}).`);

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
        throw new Error('glab CLI not found on PATH (required for "forge": "gitlab").');
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
  // Let glab construct the request body and headers. Sending a raw JSON stream
  // through `--input -` produces HTTP 415 on some GitLab installations and
  // proxies. `--raw-field` keeps strings literal; `--field` type-converts, so
  // booleans (e.g. merge_when_pipeline_succeeds) reach the API as JSON booleans.
  if (body !== undefined) {
    for (const [key, value] of Object.entries(body)) {
      args.push(typeof value === 'string' ? '--raw-field' : '--field', `${key}=${String(value)}`);
    }
  }
  const stdout = await withGitlabRetry(label, () => exec(args));
  return stdout ? JSON.parse(stdout) : undefined;
}

/**
 * The `position[...]` half of a diff-comment POST, as query parameters.
 *
 * It cannot go through apiWrite's fields: `glab api --field 'position[new_line]=42'`
 * keeps the bracketed key *literal* in the JSON body it builds
 * (`{"position[new_line]": 42}`), which is not the nested `position` hash the
 * API declares — GitLab ignores it and files the comment as an ordinary
 * MR-level thread instead of on the line. Bracketed *query* parameters are
 * parsed into that nested hash, and query parameters are merged with the JSON
 * body, so the position rides in the URL while the body stays a field.
 */
function positionQuery(refs: { base_sha: string; start_sha: string; head_sha: string }, comment: InlineComment): string {
  const params: Record<string, string | number> = {
    'position[position_type]': 'text',
    'position[base_sha]': refs.base_sha,
    'position[start_sha]': refs.start_sha,
    'position[head_sha]': refs.head_sha,
    'position[new_path]': comment.path,
    // old_path is required even for an added line; for a file that was not
    // renamed it is simply the same path.
    'position[old_path]': comment.path,
    'position[new_line]': comment.line,
  };
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
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

/**
 * One GitLab discussion as an open thread, or undefined when it is nothing a
 * reviewer can answer: a system note ("added 3 commits"), an already-resolved
 * thread, or a discussion whose notes are all system notes. GitLab tracks
 * resolution per note, and a thread counts as settled as soon as any of its
 * resolvable notes is resolved — the UI resolves them together.
 */
function toMrComment(discussion: any): MrComment | undefined {
  const notes = (discussion.notes ?? []).filter((note: any) => note.system !== true);
  if (notes.length === 0) return undefined;
  if (notes.some((note: any) => note.resolved === true)) return undefined;

  const first = notes[0];
  const position = first.position ?? {};
  return {
    id: String(discussion.id),
    // Only a resolvable discussion (one anchored to the diff) can be marked
    // resolved; an MR-level discussion has no resolution state at all.
    ...(notes.some((note: any) => note.resolvable === true) ? { resolvableId: String(discussion.id) } : {}),
    author: first.author?.username ?? 'unknown',
    body: renderThread(notes.map((note: any) => ({ author: note.author?.username ?? 'unknown', body: note.body ?? '' }))),
    ...(position.new_path ? { path: position.new_path } : {}),
    ...(typeof position.new_line === 'number' ? { line: position.new_line } : {}),
    // Every GitLab note lives in a discussion, and every discussion takes
    // notes — there is no unthreadable comment on this forge.
    threadable: true,
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

    async updateMrDescription(mrIid: number, description: string, version?: string): Promise<void> {
      await apiWrite(exec, auth, `GitLab API PUT merge_requests/${mrIid}`, 'PUT', projectPath(auth, `/merge_requests/${mrIid}`), { description });
    },

    async getMrDescription(mrIid: number): Promise<{ text: string; version?: string }> {
      const raw = await apiGet(exec, auth, `GitLab API GET merge_requests/${mrIid}`, projectPath(auth, `/merge_requests/${mrIid}`));
      return { text: raw.description ?? '', version: raw.updated_at };
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

    async createInlineComment(mrIid: number, comment: InlineComment): Promise<{ id: number }> {
      // GitLab anchors a diff comment to a position triple (base/start/head
      // shas) that only the MR itself knows, so it is read per comment rather
      // than guessed from the local worktree — a stale triple is rejected.
      const mr = await apiGet(exec, auth, `GitLab API GET merge_requests/${mrIid}`, projectPath(auth, `/merge_requests/${mrIid}`));
      const refs = mr.diff_refs ?? {};
      if (!refs.base_sha || !refs.start_sha || !refs.head_sha) {
        throw new Error(`GitLab MR !${mrIid} reports no diff_refs, so ${comment.path}:${comment.line} has no position to anchor to.`);
      }
      const raw = await apiWrite(
        exec,
        auth,
        `GitLab API POST merge_requests/${mrIid}/discussions`,
        'POST',
        `${projectPath(auth, `/merge_requests/${mrIid}/discussions`)}?${positionQuery(refs, comment)}`,
        // Only the body stays a field: it is arbitrarily long (a suggestion
        // block can run to kilobytes) and belongs nowhere near a URL.
        { body: comment.body },
      );
      // GitLab accepts a discussion whose position it did not understand and
      // silently files it as an ordinary MR-level thread — the exact failure
      // this whole feature exists to avoid — so an unanchored note is reported
      // as a rejection rather than counted as a posted comment.
      const posted = Array.isArray(raw.notes) ? raw.notes[0] : undefined;
      if (!posted?.position) {
        throw new Error(`GitLab created the comment without a diff position, so it would not appear on ${comment.path}:${comment.line}.`);
      }
      // The discussion's own id is a hash string; the note id is the numeric one.
      return { id: posted.id };
    },

    async listMrComments(mrIid: number): Promise<MrComment[]> {
      const list = await apiGet(
        exec,
        auth,
        `GitLab API GET merge_requests/${mrIid}/discussions`,
        projectPath(auth, `/merge_requests/${mrIid}/discussions?per_page=100`),
      );
      return (Array.isArray(list) ? list : []).map(toMrComment).filter((comment): comment is MrComment => comment !== undefined);
    },

    async replyToComment(mrIid: number, commentId: string, body: string): Promise<{ id: number }> {
      const raw = await apiWrite(
        exec,
        auth,
        `GitLab API POST merge_requests/${mrIid}/discussions/${commentId}/notes`,
        'POST',
        projectPath(auth, `/merge_requests/${mrIid}/discussions/${encodeURIComponent(commentId)}/notes`),
        { body },
      );
      return { id: raw.id };
    },

    async resolveComment(mrIid: number, resolvableId: string): Promise<void> {
      await apiWrite(
        exec,
        auth,
        `GitLab API PUT merge_requests/${mrIid}/discussions/${resolvableId}`,
        'PUT',
        projectPath(auth, `/merge_requests/${mrIid}/discussions/${encodeURIComponent(resolvableId)}`),
        // A boolean goes through --field, so GitLab receives JSON true rather
        // than the string "true", which it rejects (see apiWrite).
        { resolved: true },
      );
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
