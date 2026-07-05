/**
 * Custom forge MCP server (GitLab or GitHub, per config) using stdio
 * transport. Exposes the minimum tool set an agent needs to drive steps 7-8
 * of the pipeline-worker workflow (open an MR/PR, watch its pipeline, inspect
 * failures, leave a human-escalation note). Every tool response is
 * TOON-encoded via toon/envelope.ts to minimize the tokens an agent spends
 * reading forge state.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config/loader.js';
import { createForge } from '../forge/index.js';
import type { ForgeClient } from '../forge/types.js';
import { buildEnvelope, errorEnvelope } from '../toon/envelope.js';
import type { PipelineStatus } from '../types.js';

function toolResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Every tool follows the same try/create-forge/call/envelope-or-error shape. */
function wrap<Args>(handler: (forge: ForgeClient, args: Args) => Promise<string>) {
  return async (args: Args): Promise<CallToolResult> => {
    try {
      const forge = createForge(loadConfig(process.cwd()));
      const text = await handler(forge, args);
      return toolResult(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolResult(errorEnvelope('forge_error', message), true);
    }
  };
}

const fullFlag = z.boolean().describe('Skip truncation and return the full payload').optional();

function describeNextPipelineAction(status: PipelineStatus): string | undefined {
  if (status === 'failed') return 'call get_failed_jobs with this pipeline id';
  if (status === 'running' || status === 'pending') return 'poll again shortly';
  return undefined;
}

export async function createServer() {
  const server = new McpServer({ name: 'pipeline-worker-forge', version: '0.1.0' });

  server.registerTool(
    'create_merge_request',
    {
      description: 'Create a merge request / pull request for a pushed branch',
      inputSchema: z.object({
        sourceBranch: z.string(),
        targetBranch: z.string(),
        title: z.string(),
        description: z.string(),
      }),
    },
    wrap(async (forge, args: { sourceBranch: string; targetBranch: string; title: string; description: string }) => {
      const mr = await forge.createMergeRequest(args);
      return buildEnvelope({ status: 'success', data: mr, next: 'call get_pipeline_status with this mr iid' });
    }),
  );

  server.registerTool(
    'get_pipeline_status',
    {
      description: "Get an MR/PR's latest pipeline status",
      inputSchema: z.object({ mrIid: z.number() }),
    },
    wrap(async (forge, args: { mrIid: number }) => {
      const pipelines = await forge.getMrPipelines(args.mrIid);
      const latest = pipelines[0];
      if (!latest) {
        return buildEnvelope({ status: 'success', counts: { pipelines: 0 }, next: 'no pipeline yet, poll again shortly' });
      }
      return buildEnvelope({ status: 'success', data: latest, next: describeNextPipelineAction(latest.status) });
    }),
  );

  server.registerTool(
    'get_failed_jobs',
    {
      description: 'List the failed jobs for a pipeline',
      inputSchema: z.object({ pipelineId: z.number() }),
    },
    wrap(async (forge, args: { pipelineId: number }) => {
      const jobs = await forge.getFailedJobs(args.pipelineId);
      return buildEnvelope({
        status: 'success',
        data: jobs,
        counts: { failedJobs: jobs.length },
        next: jobs.length > 0 ? 'call get_job_log with a job id' : undefined,
      });
    }),
  );

  server.registerTool(
    'get_job_log',
    {
      description: "Get a job's log output (trace), truncated by default",
      inputSchema: z.object({ jobId: z.number(), full: fullFlag }),
    },
    wrap(async (forge, args: { jobId: number; full?: boolean }) => {
      const log = await forge.getJobLog(args.jobId);
      return buildEnvelope({ status: 'success', data: log }, { full: args.full });
    }),
  );

  server.registerTool(
    'retry_pipeline',
    {
      description: 'Retry a failed pipeline',
      inputSchema: z.object({ pipelineId: z.number() }),
    },
    wrap(async (forge, args: { pipelineId: number }) => {
      const pipeline = await forge.retryPipeline(args.pipelineId);
      return buildEnvelope({ status: 'success', data: pipeline });
    }),
  );

  server.registerTool(
    'create_mr_comment',
    {
      description: 'Leave a comment/note on a merge request / pull request',
      inputSchema: z.object({ mrIid: z.number(), body: z.string() }),
    },
    wrap(async (forge, args: { mrIid: number; body: string }) => {
      const note = await forge.createMrNote(args.mrIid, args.body);
      return buildEnvelope({ status: 'success', data: note });
    }),
  );

  return server;
}

export async function startServer() {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}
