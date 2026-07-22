/**
 * Headless GitHub Copilot CLI adapter. Flags verified against GitHub's
 * "Copilot CLI programmatic reference" docs: `-s` (suppress stats/decoration,
 * output only the agent's response), `--no-ask-user`, `--allow-all-tools`
 * and `--allow-all-paths` — both required for unattended fix runs, since
 * tool approval and path/directory-trust approval are separate gates in
 * Copilot CLI. Without `--allow-all-paths`, every run's disposable worktree
 * is a directory Copilot has never seen before, so any shell command
 * touching files there (e.g. listing test projects) trips the "trust this
 * directory?" prompt; with no TTY to answer it, the CLI fails with
 * permission-denied instead. Known gaps vs the Claude adapter, handled here:
 *  - no structured-output/JSON-schema flag -> the schema is embedded in the
 *    prompt and the JSON object is extracted from the response text;
 *  - no per-invocation MCP config flag -> Copilot only reads
 *    ~/.copilot/mcp-config.json, so `mcpConfigPath` is ignored with a warning.
 *  - `--model` expects Copilot's own model names (e.g. `claude-haiku-4.5`),
 *    not the Claude CLI aliases the config defaults to -> known aliases are
 *    mapped (haiku/sonnet), anything else is passed through verbatim.
 *  - no per-invocation tool allowlist -> `--allow-all-tools` is always passed,
 *    so `allowedTools` is ignored; a read-only step (e.g. captureIntent.ts)
 *    gets full tool access under this adapter instead of being restricted.
 *  - no way to learn the session id the CLI picked for itself in
 *    non-interactive mode (open feature request: github/copilot-cli#807) ->
 *    every invocation is given an explicit `--name`, which `copilot --resume
 *    <name>` (or `/resume` in an interactive session) can look up later, so
 *    callers still get a stable identifier to report even though it isn't
 *    the CLI's own internal session id.
 *
 * The prompt is piped over stdin rather than passed via `-p <prompt>`.
 * captureIntent.ts embeds a full git diff in the prompt, and a large diff can
 * exceed the OS's exec() argument size limit (E2BIG). Per GitHub's docs,
 * piped stdin is ignored whenever `-p`/`--prompt` is also given a value, so
 * `-p` is omitted entirely; `copilot` reads the prompt from stdin and runs
 * non-interactively since stdin isn't a TTY (documented as
 * `echo "..." | copilot`).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AGENT_INVOKE_TIMEOUT_MS, type AgentAdapter, type AgentInvokeOptions, type AgentInvokeResult } from './types.js';
import { writePromptToStdin } from './stdinPrompt.js';

const execFileAsync = promisify(execFile);

/** Pulls the outermost JSON object out of a text answer that may have prose around it. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

/** Embeds a JSON-Schema instruction in the prompt text — Copilot CLI has no native structured-output flag (see module comment). */
function buildCopilotPrompt(prompt: string, jsonSchema?: object): string {
  if (!jsonSchema) return prompt;
  return `${prompt}\n\nRespond with ONLY a single JSON object matching this JSON Schema — no prose, no code fences:\n${JSON.stringify(jsonSchema)}`;
}

/** Warns about the AgentInvokeOptions Copilot CLI has no per-invocation flag for (see module comment). */
function warnUnsupportedOptions(opts: AgentInvokeOptions): void {
  if (opts.mcpConfigPath) {
    console.error(
      'pipeline-worker: copilot CLI has no per-invocation MCP config flag; ignoring it. ' +
        'Register the server in ~/.copilot/mcp-config.json to give copilot forge access.',
    );
  }
}

/** Copilot's `--model` takes its own model names, not the Claude CLI aliases config defaults to (see module comment). */
const COPILOT_MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4.5',
  sonnet: 'claude-sonnet-4.5',
};

function resolveCopilotModel(model: string): string {
  return COPILOT_MODEL_ALIASES[model] ?? model;
}

export const copilotAdapter: AgentAdapter = {
  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const prompt = buildCopilotPrompt(opts.prompt, opts.jsonSchema);
    warnUnsupportedOptions(opts);

    const sessionName = `pipeline-worker-${randomUUID()}`;
    const args = ['-s', '--no-ask-user', '--allow-all-tools', '--allow-all-paths', '--name', sessionName];
    if (opts.model) args.push('--model', resolveCopilotModel(opts.model));
    const start = Date.now();
    const invocation = execFileAsync(
      'copilot',
      args,
      {
        cwd: opts.cwd,
        timeout: AGENT_INVOKE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
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
