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
 *  - `--model` expects Copilot's own model names (e.g. `claude-haiku-4.5`),
 *    not the Claude CLI aliases the config defaults to -> known aliases are
 *    mapped (haiku/sonnet), anything else is passed through verbatim.
 *  - no `--system-prompt` flag -> `opts.systemPrompt` is prepended to the
 *    prompt text instead (see promptText.ts);
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
import { composePrompt } from './promptText.js';

const execFileAsync = promisify(execFile);

/**
 * Fallback for the missing `--json-schema` flag (see module comment): copilot
 * only ever sees a schema's constraints as prose folded into the prompt (see
 * promptText.ts), so nothing stops it from answering with, say, a string a
 * few characters over its `maxLength`. Rather than let that turn into a
 * downstream Zod "too_big" failure (e.g. captureIntent.ts's 72-char commit
 * subject), walk the parsed answer against the schema it was asked to match
 * and clip any oversize string to fit — a shortened field beats failing the
 * whole run over one miscounted constraint.
 */
function clipToSchema(value: unknown, schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return value;
  const s = schema as { maxLength?: number; items?: unknown; properties?: Record<string, unknown> };
  if (typeof value === 'string' && typeof s.maxLength === 'number' && value.length > s.maxLength) {
    return value.slice(0, s.maxLength);
  }
  if (Array.isArray(value) && s.items) {
    return value.map((item) => clipToSchema(item, s.items));
  }
  if (value !== null && typeof value === 'object' && s.properties) {
    const clipped: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, propSchema] of Object.entries(s.properties)) {
      if (key in clipped) clipped[key] = clipToSchema(clipped[key], propSchema);
    }
    return clipped;
  }
  return value;
}

/**
 * Pulls the outermost JSON object out of a text answer that may have prose
 * around it, then clips any field the schema bounds with `maxLength` (see
 * clipToSchema). Clipping is best-effort: unparsable JSON is returned as-is
 * and left for the caller's own schema validation to reject with the real
 * parse error.
 */
function extractJsonObject(text: string, schema?: object): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const jsonText = start !== -1 && end > start ? text.slice(start, end + 1) : text;
  if (!schema) return jsonText;
  try {
    return JSON.stringify(clipToSchema(JSON.parse(jsonText), schema));
  } catch {
    return jsonText;
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
    // Copilot CLI has no --system-prompt or --json-schema flag, so both are
    // folded into the prompt text (see promptText.ts).
    const prompt = composePrompt(opts);

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
      text: opts.jsonSchema ? extractJsonObject(stdout, opts.jsonSchema) : stdout.trim(),
      sessionId: sessionName,
      durationMs: Date.now() - start,
    };
  },
};
