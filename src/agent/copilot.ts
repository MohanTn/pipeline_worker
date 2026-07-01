/**
 * Headless GitHub Copilot CLI adapter. Flags verified against GitHub's
 * "Copilot CLI programmatic reference" docs: `-p <prompt>` (non-interactive
 * single shot), `-s` (suppress stats/decoration, output only the agent's
 * response), `--no-ask-user`, `--allow-all-tools` (required for unattended
 * fix runs). Known gaps vs the Claude adapter, handled here:
 *  - no structured-output/JSON-schema flag -> the schema is embedded in the
 *    prompt and the JSON object is extracted from the response text;
 *  - no per-invocation MCP config flag -> Copilot only reads
 *    ~/.copilot/mcp-config.json, so `mcpConfigPath` is ignored with a warning.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from './types.js';

const execFileAsync = promisify(execFile);

const INVOKE_TIMEOUT_MS = 300_000;

/** Pulls the outermost JSON object out of a text answer that may have prose around it. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

export const copilotAdapter: AgentAdapter = {
  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    let prompt = opts.prompt;
    if (opts.jsonSchema) {
      prompt +=
        '\n\nRespond with ONLY a single JSON object matching this JSON Schema — no prose, no code fences:\n' +
        JSON.stringify(opts.jsonSchema);
    }
    if (opts.mcpConfigPath) {
      console.error(
        'pipeline-worker: copilot CLI has no per-invocation MCP config flag; ignoring it. ' +
          'Register the server in ~/.copilot/mcp-config.json to give copilot forge access.',
      );
    }

    const { stdout } = await execFileAsync('copilot', ['-p', prompt, '-s', '--no-ask-user', '--allow-all-tools'], {
      cwd: opts.cwd,
      timeout: INVOKE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });

    return { text: opts.jsonSchema ? extractJsonObject(stdout) : stdout.trim() };
  },
};
