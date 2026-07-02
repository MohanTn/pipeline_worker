/**
 * Step 8: poll the MR/PR's pipeline (at config.pollIntervalSeconds) until it
 * succeeds; on failure, hand the failing jobs' logs to the configured agent
 * (with pipeline-worker's own forge MCP server available so it can pull further
 * detail itself), commit the fix, push, and retry — capped at
 * config.maxFixAttempts before escalating via an MR comment. Never retries
 * indefinitely, and never spends agent tokens on pipelines that are not
 * actually failed (canceled/skipped go straight to a human).
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { AgentAdapter } from '../agent/types.js';
import { stageAll, commit, push, hasChanges } from '../git/commit.js';
import type { ForgeClient } from '../forge/types.js';
import { saveRunState } from '../state/runState.js';
import { step, runStep, note } from '../ui/steps.js';
import type { PipelineWorkerConfig, Pipeline, PipelineJob, RunState } from '../types.js';

const MAX_POLL_WINDOW_MS = 2 * 60 * 60 * 1000; // per pipeline attempt, as a safety net
const TERMINAL_STATUSES: Pipeline['status'][] = ['success', 'failed', 'canceled', 'skipped'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a *new* terminal pipeline: `previousPipelineId` is the one we
 * already handled, and it stays "latest" on the forge until the pipeline for
 * our fix push is created — without this, the loop would re-fix stale logs
 * and burn attempts on a single real failure.
 */
async function pollLatestPipeline(
  forge: ForgeClient,
  mrIid: number,
  intervalMs: number,
  previousPipelineId?: number,
): Promise<Pipeline> {
  const maxPolls = Math.max(1, Math.ceil(MAX_POLL_WINDOW_MS / intervalMs));
  for (let i = 0; i < maxPolls; i++) {
    const pipelines = await forge.getMrPipelines(mrIid);
    const latest = pipelines[0];
    if (latest && latest.id !== previousPipelineId && TERMINAL_STATUSES.includes(latest.status)) {
      return latest;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Pipeline for MR ${mrIid} did not reach a terminal state within the polling window`);
}

function writeAgentMcpConfig(): string {
  const path = join(tmpdir(), `pipeline-worker-mcp-${randomUUID()}.json`);
  const config = { mcpServers: { 'pipeline-worker-forge': { type: 'stdio', command: 'npx', args: ['pipeline-worker', 'serve'], env: {} } } };
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  return path;
}

function buildFixPrompt(pipeline: Pipeline, jobs: Array<{ job: PipelineJob; log: string }>): string {
  const jobSummaries = jobs
    .map(({ job, log }) => `### Job "${job.name}" (stage: ${job.stage})\n\`\`\`\n${log.slice(-4000)}\n\`\`\``)
    .join('\n\n');
  return (
    `The CI pipeline ${pipeline.webUrl} failed. Fix the underlying issue in this worktree so the pipeline passes. ` +
    'You have access to the pipeline-worker-forge MCP server for further pipeline/job detail if these excerpts are not enough.\n\n' +
    jobSummaries
  );
}

async function escalate(forge: ForgeClient, mrIid: number, message: string, state: RunState, repoRoot: string): Promise<void> {
  await runStep('Escalating to a human', message, () => forge.createMrNote(mrIid, message));
  state.phase = 'escalated';
  saveRunState(repoRoot, state);
}

export async function watchPipeline(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  branch: string,
  mrIid: number,
  state: RunState,
  repoRoot: string,
): Promise<void> {
  const intervalMs = config.pollIntervalSeconds * 1000;
  state.phase = 'watch';
  saveRunState(repoRoot, state);

  let previousPipelineId: number | undefined;
  for (;;) {
    const pipeline = await runStep(
      'Watching pipeline',
      `poll CI every ${config.pollIntervalSeconds}s until it finishes`,
      () => pollLatestPipeline(forge, mrIid, intervalMs, previousPipelineId),
    );
    note(`pipeline ${pipeline.id}: ${pipeline.status} — ${pipeline.webUrl}`);
    state.pipelineId = pipeline.id;
    saveRunState(repoRoot, state);

    if (pipeline.status === 'success') {
      state.phase = 'done';
      saveRunState(repoRoot, state);
      return;
    }

    if (pipeline.status !== 'failed') {
      // canceled/skipped: there are no failing jobs to fix — don't spend agent tokens.
      await escalate(
        forge,
        mrIid,
        `pipeline-worker: pipeline ${pipeline.webUrl} ended as "${pipeline.status}" — nothing to auto-fix, needs a human decision.`,
        state,
        repoRoot,
      );
      return;
    }

    state.attempt += 1;
    saveRunState(repoRoot, state);

    step('Pipeline failed', `attempt ${state.attempt}/${config.maxFixAttempts} — ${pipeline.webUrl}`);
    if (state.attempt > config.maxFixAttempts) {
      await escalate(
        forge,
        mrIid,
        `pipeline-worker: automated fix attempts exhausted (${state.attempt - 1} attempts). ` +
          `Pipeline ${pipeline.webUrl} is still failing and needs a human to take over.`,
        state,
        repoRoot,
      );
      return;
    }

    const { failedJobs, logs } = await runStep('Diagnosing the failure', `reading logs for ${pipeline.webUrl}`, async () => {
      const jobs = await forge.getFailedJobs(pipeline.id);
      const jobLogs = await Promise.all(jobs.map(async (job) => ({ job, log: await forge.getJobLog(job.id) })));
      return { failedJobs: jobs, logs: jobLogs };
    });
    note(failedJobs.length > 0 ? failedJobs.map((job) => job.name).join(', ') : 'no specific job names reported');

    const mcpConfigPath = writeAgentMcpConfig();
    let agentResponse: string;
    try {
      agentResponse = await runStep(
        'Fixing CI failure',
        `asking the agent to fix ${failedJobs.length} failed job(s)`,
        async () => (await agent.invoke({ prompt: buildFixPrompt(pipeline, logs), cwd: worktreePath, mcpConfigPath, permissionMode: 'acceptEdits' })).text,
      );
    } finally {
      unlinkSync(mcpConfigPath);
    }
    note(`agent: ${agentResponse.slice(0, 300).trim()}${agentResponse.length > 300 ? '…' : ''}`);

    if (!(await hasChanges(worktreePath))) {
      // Re-pushing an identical tree would never produce a new pipeline; stop here.
      await escalate(
        forge,
        mrIid,
        `pipeline-worker: fix attempt ${state.attempt} produced no changes for pipeline ${pipeline.webUrl} — escalating to a human.`,
        state,
        repoRoot,
      );
      return;
    }

    await runStep('Pushing the fix', `commit and push attempt ${state.attempt} to ${branch}`, async () => {
      await stageAll(worktreePath);
      await commit(worktreePath, `fix: address CI failure (attempt ${state.attempt})`);
      await push(worktreePath, 'origin', branch);
    });
    previousPipelineId = pipeline.id;
  }
}
