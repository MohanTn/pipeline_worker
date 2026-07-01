/**
 * Headless Claude Code adapter. Flags verified against the locally installed
 * `claude` CLI: `-p/--print`, `--output-format json`, `--permission-mode`,
 * `--json-schema`, `--mcp-config`. There is no `--cwd` flag — working
 * directory is controlled by the spawned process's `cwd` option.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from './types.js';

const execFileAsync = promisify(execFile);

const INVOKE_TIMEOUT_MS = 300_000;

export const claudeAdapter: AgentAdapter = {
  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const args = [
      '-p', opts.prompt,
      '--output-format', 'json',
      '--permission-mode', opts.permissionMode ?? 'acceptEdits',
    ];
    if (opts.jsonSchema) {
      args.push('--json-schema', JSON.stringify(opts.jsonSchema));
    }
    if (opts.mcpConfigPath) {
      args.push('--mcp-config', opts.mcpConfigPath);
    }

    const { stdout } = await execFileAsync('claude', args, {
      cwd: opts.cwd,
      timeout: INVOKE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });

    try {
      const parsed = JSON.parse(stdout) as { result?: string };
      return { text: parsed.result ?? stdout, raw: parsed };
    } catch {
      // --output-format json should always produce parseable JSON; fall back
      // to the raw stream rather than throwing, since the invocation itself succeeded.
      return { text: stdout };
    }
  },
};
