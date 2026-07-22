/**
 * Drives the compiled CLI's `serve` subcommand as a subprocess (mirroring
 * mcp-sonar-analysis's test/cli.test.ts convention), against a local HTTP
 * stub standing in for the GitLab API. The real GitLab forge shells out to
 * the `glab` CLI, so tests that reach it also stand up a fake `glab` on
 * PATH (see writeFakeGlab) that forwards to the stub — no real network
 * calls or real glab binary needed in CI.
 *
 * NOTE: requires `npm run build` to have run first (exercises dist/cli.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http, { type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

  // fallow-ignore-next-line complexity
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

/**
 * The real GitLab forge shells out to the `glab` CLI, which this test
 * environment doesn't have installed. Stands a fake `glab` executable up on
 * PATH that translates `glab api <path> [-X method] [--hostname h] [--input -]`
 * into a plain HTTP request against `startGitlabStub`'s local server, so the
 * spawned dist/cli.js subprocess still exercises the real request/response
 * plumbing without a real glab binary or real network access.
 */
function writeFakeGlab(): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), 'fake-glab-'));
  const source = `#!/usr/bin/env node
const http = require('node:http');
const argv = process.argv.slice(2); // ['api', path, ...flags]
const path = argv[1];
let method = 'GET';
let hostname = '';
let useStdin = false;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '-X') method = argv[++i];
  else if (argv[i] === '--hostname') hostname = argv[++i];
  else if (argv[i] === '--input') useStdin = argv[++i] === '-';
}
const [host, port] = hostname.split(':');
function run(body) {
  const req = http.request(
    { hostname: host, port: Number(port) || 80, path: '/' + path.replace(/^\\/+/, ''), method, headers: { 'content-type': 'application/json' } },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          process.stderr.write(res.statusCode + ' ' + res.statusMessage + ': ' + data);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(data);
      });
    },
  );
  req.on('error', (err) => {
    process.stderr.write(String(err));
    process.exitCode = 1;
  });
  if (body) req.write(body);
  req.end();
}
if (useStdin) {
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => run(input));
} else {
  run();
}
`;
  const scriptPath = join(binDir, 'glab');
  writeFileSync(scriptPath, source);
  chmodSync(scriptPath, 0o755);
  return { binDir, cleanup: () => rmSync(binDir, { recursive: true, force: true }) };
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
  const { binDir, cleanup } = writeFakeGlab();
  const probe = new McpProbe({
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
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
    cleanup();
  }
});
