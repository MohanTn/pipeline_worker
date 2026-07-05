/**
 * Headless pi CLI adapter. Flags verified against pi's CLI reference:
 * `-p/--print` for non-interactive output, `--provider`, `--model` for
 * per-invocation model selection, `--tools` for tool allowlisting, `--name`
 * for session labelling.
 *
 * Pi supports any model from its extensive provider list: Anthropic, OpenAI,
 * Google Gemini, DeepSeek, Groq, OpenRouter, etc. Users configure their
 * provider/api-key via pi's own setup (`/login`) or env vars; this adapter
 * passes through `opts.model` (e.g. the configured
 * `PIPELINE_WORKER_INTENT_MODEL`) so each invocation can use a different
 * model.
 *
 * Known gaps vs the Claude adapter, handled here:
 *  - no structured-output/JSON-schema flag -> the schema is embedded in the
 *    prompt and the JSON object is extracted from the response text (same
 *    strategy as the copilot adapter);
 *  - no per-invocation MCP config flag -> `mcpConfigPath` is unsupported;
 *    register the server in pi's config or pass `-e` in pi's own settings;
 *  - no `--allowedTools` flag -> pi uses `--tools <list>` for allowlisting,
 *    so `opts.allowedTools` is mapped from Claude-style names to pi-style
 *    names (PascalCase -> lowercase, scoped patterns e.g. `Bash(git diff:*)`
 *    -> `bash`) before being passed;
 *  - no `--permission-mode` flag -> pi in `-p` mode is non-interactive by
 *    default, so `opts.permissionMode` is ignored;
 *  - the prompt is piped over stdin rather than passed as a CLI argument,
 *    since large prompts (e.g. full git diff) can exceed the OS's exec()
 *    argument size limit (E2BIG). Pi reads piped stdin and merges it into
 *    the initial prompt when using `-p`.
 *
 * Session tracking: pi supports `--name` for a display name and `--session`
 * for resuming a specific session. We pass `--name` so the user can look up
 * what pi did; the session id isn't returned in print mode, so `sessionId`
 * is set to the name we chose.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AGENT_INVOKE_TIMEOUT_MS, type AgentAdapter, type AgentInvokeOptions, type AgentInvokeResult } from './types.js';
import { writePromptToStdin } from './stdinPrompt.js';

const execFileAsync = promisify(execFile);

/**
 * Maps a Claude-style tool name to the pi equivalent. Claude uses PascalCase
 * and supports scoped patterns like `Bash(git diff:*)`; pi uses lowercase
 * names only and has no scoping — a scoped bash pattern maps to `bash`.
 *
 * Known mappings:
 *   Read  -> read
 *   Grep  -> grep
 *   Glob  -> find   (pi has `find` rather than `glob`)
 *   Write -> write
 *   Edit  -> edit
 *   Bash* -> bash
 *   *     -> passed through lowercased
 */
function mapToolName(claudeName: string): string {
  const lower = claudeName.toLowerCase();
  if (lower === 'glob') return 'find';
  if (lower.startsWith('bash')) return 'bash';
  return lower;
}

/** Pulls the outermost JSON object out of a text answer that may have prose around it. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

export const piAdapter: AgentAdapter = {
  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const args: string[] = ['-p'];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.allowedTools?.length) {
      const mapped = opts.allowedTools.map(mapToolName);
      args.push('--tools', mapped.join(','));
    }

    const sessionName = `pipeline-worker-${randomUUID()}`;
    args.push('--name', sessionName);

    let prompt = opts.prompt;
    if (opts.jsonSchema) {
      prompt +=
        '\n\nRespond with ONLY a single JSON object matching this JSON Schema — no prose, no code fences:\n' +
        JSON.stringify(opts.jsonSchema);
    }

    const start = Date.now();
    const invocation = execFileAsync('pi', args, {
      cwd: opts.cwd,
      timeout: AGENT_INVOKE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    // stdin is always a pipe here since stdio isn't overridden in execFileAsync's options.
    writePromptToStdin(invocation.child.stdin!, prompt);
    const { stdout } = await invocation;

    return {
      text: opts.jsonSchema ? extractJsonObject(stdout) : stdout.trim(),
      sessionId: sessionName,
      durationMs: Date.now() - start,
    };
  },
};
