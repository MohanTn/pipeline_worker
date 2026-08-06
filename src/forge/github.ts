/**
 * GitHub REST ForgeClient. Maps GitHub concepts onto the forge-neutral
 * shapes: pull request -> MergeRequest (iid = PR number), the set of Actions
 * workflow runs for the PR's head SHA -> one aggregated Pipeline, workflow
 * jobs -> PipelineJob. The token comes from the settings file's
 * `github.token` (see config/file.ts) and is never logged.
 */

import type { MergeMethod, PipelineWorkerConfig, MergeRequest, Pipeline, PipelineJob, PipelineStatus } from '../types.js';
import type { CreateMrArgs, ForgeClient, InlineComment, MrComment } from './types.js';
import { forgeFetch, firstOrUndefined, parseIdResponse, renderThread } from './shared.js';
import { configFilePath } from '../config/file.js';

interface GithubAuth {
  apiUrl: string;
  /** "owner/name" slug. */
  repo: string;
  token: string;
}

// fallow-ignore-next-line complexity
function resolveGithubAuth(config: PipelineWorkerConfig): GithubAuth {
  // Everything here is already resolved by config/loader.ts from
  // ~/.config/pipeline-worker/config.json (repo also falls back to the
  // repo's own origin remote).
  const { apiUrl, repo, token } = config.github;

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`GitHub repo is not configured (set "github": { "repo": "owner/name" } in ${configFilePath()}).`);
  }
  if (!token) throw new Error(`GitHub token is not configured (set "github": { "token": "..." } in ${configFilePath()}).`);

  return { apiUrl: apiUrl.replace(/\/$/, ''), repo, token };
}

async function githubRequest(auth: GithubAuth, path: string, init?: RequestInit): Promise<Response> {
  return forgeFetch(
    'GitHub API',
    path,
    `${auth.apiUrl}/repos/${auth.repo}${path}`,
    {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    init,
  );
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

// fallow-ignore-next-line complexity
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
// fallow-ignore-next-line complexity
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

/**
 * REST and GraphQL live at different paths: github.com's REST base is
 * https://api.github.com, GraphQL is https://api.github.com/graphql. GitHub
 * Enterprise Server's REST base ends in /api/v3; its GraphQL endpoint is
 * .../api/graphql (not /api/v3/graphql) — the two APIs don't nest under the
 * same versioned prefix there.
 */
export function githubGraphqlUrl(apiUrl: string): string {
  return apiUrl.endsWith('/api/v3') ? `${apiUrl.slice(0, -'/api/v3'.length)}/api/graphql` : `${apiUrl}/graphql`;
}

const MERGE_METHOD_ENUM: Record<MergeMethod, string> = { merge: 'MERGE', squash: 'SQUASH', rebase: 'REBASE' };

const ENABLE_AUTO_MERGE_MUTATION =
  'mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) { ' +
  'enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) { clientMutationId } }';

/**
 * Review threads must come from GraphQL, not REST: `/pulls/{n}/comments`
 * returns every review comment but says nothing about whether its thread was
 * resolved, so a REST-only reader would keep re-answering settled threads.
 * `line` is null on an outdated thread, which is why the mapped anchor is
 * optional.
 */
const REVIEW_THREADS_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { ' +
  'repository(owner: $owner, name: $name) { pullRequest(number: $number) { ' +
  'reviewThreads(first: 100) { nodes { id isResolved comments(first: 50) { nodes { ' +
  'databaseId body path line url author { login } } } } } } } }';

/** Resolving is GraphQL-only as well, and it takes the thread's node id — not the comment's databaseId that replies use. */
const RESOLVE_THREAD_MUTATION =
  'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }';

/** Marks a PR-level (issue) comment id, which GitHub cannot thread a reply under — see MrComment.threadable. */
const ISSUE_COMMENT_PREFIX = 'issue:';

interface GraphqlComment {
  databaseId: number;
  body: string | null;
  path: string | null;
  line: number | null;
  url: string | null;
  author: { login: string } | null;
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments?: { nodes?: GraphqlComment[] };
}

interface ReviewThreadsData {
  repository?: { pullRequest?: { reviewThreads?: { nodes?: ReviewThreadNode[] } } };
}

function toThreadComment(thread: ReviewThreadNode): MrComment | undefined {
  const notes = thread.comments?.nodes ?? [];
  const first = notes[0];
  if (!first) return undefined;
  return {
    // The thread's *first* comment is the one /replies posts under: replying
    // to a later comment's id makes GitHub open a second thread on the line.
    id: String(first.databaseId),
    // The thread's own node id, which is what resolveReviewThread takes — the
    // databaseId above is a comment id and the mutation rejects it.
    ...(thread.id ? { resolvableId: thread.id } : {}),
    author: first.author?.login ?? 'unknown',
    body: renderThread(notes.map((note) => ({ author: note.author?.login ?? 'unknown', body: note.body ?? '' }))),
    ...(first.path ? { path: first.path } : {}),
    ...(typeof first.line === 'number' ? { line: first.line } : {}),
    ...(first.url ? { url: first.url } : {}),
    threadable: true,
  };
}

// scaffold:inject

interface GraphqlResponse {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

async function githubGraphqlRequest(auth: GithubAuth, query: string, variables: object): Promise<GraphqlResponse> {
  const res = await forgeFetch(
    'GitHub GraphQL',
    '/graphql',
    githubGraphqlUrl(auth.apiUrl),
    { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    { method: 'POST', body: JSON.stringify({ query, variables }) },
  );
  return (await res.json()) as GraphqlResponse;
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
      return firstOrUndefined(list, toMergeRequest);
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

    async updateMrDescription(mrIid: number, description: string, _version?: string): Promise<void> {
      const init: RequestInit = { method: 'PATCH', body: JSON.stringify({ body: description }) };
      await githubRequest(auth, `/pulls/${mrIid}`, init);
    },

    async getMrDescription(mrIid: number): Promise<{ text: string; version?: string }> {
      const res = await githubRequest(auth, `/pulls/${mrIid}`);
      const { body } = (await res.json()) as { body: string | null };
      const version = res.headers.get('etag') ?? undefined;
      return { text: body ?? '', version };
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
      return parseIdResponse(res);
    },

    async createInlineComment(mrIid: number, comment: InlineComment): Promise<{ id: number }> {
      // commit_id must be the PR's current head: a review comment against an
      // older commit is accepted but immediately shows as outdated, hiding it
      // from the reviewer this whole feature exists to talk to.
      const prRes = await githubRequest(auth, `/pulls/${mrIid}`);
      const { head } = (await prRes.json()) as { head: { sha: string } };
      const res = await githubRequest(auth, `/pulls/${mrIid}/comments`, {
        method: 'POST',
        body: JSON.stringify({ commit_id: head.sha, path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body }),
      });
      return parseIdResponse(res);
    },

    async listMrComments(mrIid: number): Promise<MrComment[]> {
      // Two sources, because GitHub keeps them apart: line-anchored review
      // threads (GraphQL, the only place resolution state exists) and PR-level
      // comments (REST /issues/{n}/comments), which is where scanner bots such
      // as SonarQube and Checkmarx post their findings.
      const graphql = await githubGraphqlRequest(auth, REVIEW_THREADS_QUERY, { owner, name: auth.repo.split('/')[1], number: mrIid });
      if (graphql.errors?.length) throw new Error(`GitHub GraphQL reviewThreads failed: ${graphql.errors.map((e) => e.message).join('; ')}`);
      const threads = (graphql.data as ReviewThreadsData | undefined)?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      const reviewComments = threads
        .filter((thread) => !thread.isResolved)
        .map(toThreadComment)
        .filter((comment): comment is MrComment => comment !== undefined);

      const res = await githubRequest(auth, `/issues/${mrIid}/comments?per_page=100`);
      const issueComments = (await res.json()) as Array<{ id: number; body: string | null; html_url: string; user: { login: string } | null }>;
      // A PR-level comment has no thread of its own on GitHub — nothing to
      // resolve, and nothing to reply *under* (MrComment.threadable).
      const prLevel: MrComment[] = issueComments.map(
        (comment) => ({
          id: `${ISSUE_COMMENT_PREFIX}${comment.id}`,
          author: comment.user?.login ?? 'unknown',
          body: comment.body ?? '',
          url: comment.html_url,
          threadable: false,
        }),
      );
      return [...reviewComments, ...prLevel];
    },

    async replyToComment(mrIid: number, commentId: string, body: string): Promise<{ id: number }> {
      // No reply endpoint exists for a PR-level comment, so its reply lands as
      // a new top-level comment; the caller quotes the original into the body
      // so the connection is still visible (see MrComment.threadable).
      const path = commentId.startsWith(ISSUE_COMMENT_PREFIX)
        ? `/issues/${mrIid}/comments`
        : `/pulls/${mrIid}/comments/${commentId}/replies`;
      const res = await githubRequest(auth, path, { method: 'POST', body: JSON.stringify({ body }) });
      return parseIdResponse(res);
    },

    async resolveComment(_mrIid: number, resolvableId: string): Promise<void> {
      const body = await githubGraphqlRequest(auth, RESOLVE_THREAD_MUTATION, { threadId: resolvableId });
      if (body.errors?.length) {
        throw new Error(`GitHub GraphQL resolveReviewThread failed: ${body.errors.map((e) => e.message).join('; ')}`);
      }
    },

    // scaffold:inject-client

    async hasMergeConflicts(mrIid: number): Promise<boolean> {
      const res = await githubRequest(auth, `/pulls/${mrIid}`);
      const pr = (await res.json()) as { mergeable_state?: string };
      // "dirty" is GitHub's specific state for real merge conflicts; other
      // non-mergeable states (unstable, blocked, behind, draft, unknown) are
      // not conflicts and must not trigger conflict resolution.
      return pr.mergeable_state === 'dirty';
    },

    async isMrMerged(mrIid: number): Promise<boolean> {
      const res = await githubRequest(auth, `/pulls/${mrIid}`);
      const pr = (await res.json()) as { merged?: boolean };
      // `merged` is the authoritative flag; `state` alone can't distinguish
      // merged from closed-without-merging (both read "closed").
      return pr.merged === true;
    },

    async enableAutoMerge(mrIid: number, mergeMethod: MergeMethod): Promise<void> {
      const prRes = await githubRequest(auth, `/pulls/${mrIid}`);
      const pr = (await prRes.json()) as { node_id: string };
      const body = await githubGraphqlRequest(auth, ENABLE_AUTO_MERGE_MUTATION, {
        pullRequestId: pr.node_id,
        mergeMethod: MERGE_METHOD_ENUM[mergeMethod],
      });
      if (body.errors?.length) {
        throw new Error(`GitHub GraphQL enablePullRequestAutoMerge failed: ${body.errors.map((e) => e.message).join('; ')}`);
      }
    },

    // GitHub has no "custom CI config path" concept — Actions workflows are
    // always under .github/workflows, so there's nothing to look up.
    async getCiConfigPath(): Promise<string | undefined> {
      return undefined;
    },
  };
}
