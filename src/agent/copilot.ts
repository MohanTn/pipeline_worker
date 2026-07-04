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
 *  - no per-invocation model flag -> `opts.model` (e.g. the configured
 *    `PIPELINE_WORKER_INTENT_MODEL`) is ignored with a warning; switch
 *    Copilot's model via its own `/model` command or config instead.
 *  - no per-invocation tool allowlist -> `--allow-all-tools` is always passed,
 *    so `allowedTools` is ignored; a read-only step (e.g. captureIntent.ts)
 *    gets full tool access under this adapter instead of being restricted.
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
import { AGENT_INVOKE_TIMEOUT_MS, type AgentAdapter, type AgentInvokeOptions, type AgentInvokeResult } from './types.js';
import { writePromptToStdin } from './stdinPrompt.js';

const execFileAsync = promisify(execFile);

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
    if (opts.model) {
      console.error(
        `pipeline-worker: copilot CLI has no per-invocation model flag; ignoring the configured model "${opts.model}". ` +
          "Switch copilot's model via its own /model command or config instead.",
      );
    }

    const invocation = execFileAsync(
      'copilot',
      ['-s', '--no-ask-user', '--allow-all-tools', '--allow-all-paths'],
      {
        cwd: opts.cwd,
        timeout: AGENT_INVOKE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    // stdin is always a pipe here since stdio isn't overridden in execFileAsync's options.
    writePromptToStdin(invocation.child.stdin!, prompt);
    const { stdout } = await invocation;

    return { text: opts.jsonSchema ? extractJsonObject(stdout) : stdout.trim() };
  },
};
