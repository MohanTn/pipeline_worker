/**
 * Drives the compiled CLI's `serve` subcommand as a subprocess (mirroring
 * mcp-sonar-analysis's test/cli.test.ts convention), against a local HTTP
 * stub standing in for the GitLab API — no real network calls in CI.
 *
 * NOTE: requires `npm run build` to have run first (exercises dist/cli.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http, { type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

class McpProbe {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending = new Map<number, (res: JsonRpcResponse) => void>();

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn('node', [cliPath, 'serve'], { env });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  async request(id: number, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const result = new Promise<JsonRpcResponse>((resolve) => this.pending.set(id, resolve));
    this.send({ jsonrpc: '2.0', id, method, params });
    return result;
  }

  notify(method: string): void {
    this.send({ jsonrpc: '2.0', method });
  }

  async initialize(): Promise<void> {
    await this.request(0, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pipeline-worker-test', version: '1.0' },
    });
    this.notify('notifications/initialized');
  }

  stop(): void {
    this.child.kill();
  }
}

function startGitlabStub(): Promise<{ server: Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/merge_requests/7/pipelines')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 42, status: 'failed', web_url: 'http://example/pipelines/42' }]));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

test('pipeline-worker serve lists all six GitLab MCP tools', async () => {
  const probe = new McpProbe({
    ...process.env,
    PIPELINE_WORKER_GITLAB_HOST: 'http://127.0.0.1:1',
    PIPELINE_WORKER_GITLAB_PROJECT_ID: '1',
    PIPELINE_WORKER_GITLAB_TOKEN: 'test-token',
  });
  try {
    await probe.initialize();
    const response = await probe.request(1, 'tools/list', {});
    const tools = (response.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'create_merge_request',
      'create_mr_comment',
      'get_failed_jobs',
      'get_job_log',
      'get_pipeline_status',
      'retry_pipeline',
    ]);
  } finally {
    probe.stop();
  }
});

test('pipeline-worker serve returns a TOON-encoded envelope for get_pipeline_status', async () => {
  const { server, port } = await startGitlabStub();
  const probe = new McpProbe({
    ...process.env,
    PIPELINE_WORKER_FORGE: 'gitlab',
    PIPELINE_WORKER_GITLAB_HOST: `http://127.0.0.1:${port}`,
    PIPELINE_WORKER_GITLAB_PROJECT_ID: '1',
    PIPELINE_WORKER_GITLAB_TOKEN: 'test-token',
  });
  try {
    await probe.initialize();
    const response = await probe.request(1, 'tools/call', {
      name: 'get_pipeline_status',
      arguments: { mrIid: 7 },
    });
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    assert.match(text, /^status: success/);
    assert.match(text, /chars: \d+/);
    assert.match(text, /status: failed/);
    assert.match(text, /next: call get_failed_jobs with this pipeline id/);
  } finally {
    probe.stop();
    server.close();
  }
});
