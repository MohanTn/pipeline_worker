/**
 * Adapter for little-coder (https://github.com/itayinbarr/little-coder) — a
 * harness tuned for 5-25GB local models served by llama.cpp/Ollama, built on
 * pi: "pi plus 20 extensions and 30 skill markdown files". Its launcher
 * forwards argv to pi after stripping its own flags, so the flag shape used
 * here is pi's, already verified for that adapter: `-p` for non-interactive
 * print mode, `--model <provider/id>`, `--tools <list>` for the tool
 * allowlist, prompt over stdin.
 *
 * What differs from the pi adapter, and why this is its own file:
 *  - the binary is configurable (`littleCoder.binary`), since little-coder is
 *    commonly run from a checkout rather than as a global command;
 *  - every prompt is trimmed to `littleCoder.maxPromptChars` before it is
 *    handed over (see promptText.ts's truncateToBudget). A local model's
 *    context is the binding constraint here, and an over-long prompt does not
 *    fail loudly — it silently loses whichever end the runtime drops, which
 *    for a JSON-schema turn is usually the output contract. Trimming
 *    middle-out keeps the instruction and the contract intact;
 *  - `--name` is not passed. pi accepts it, but little-coder documents no
 *    session labelling of its own, so the label is generated here for
 *    reporting only rather than asserted onto the CLI.
 *
 * No JSON-schema and no system-prompt flag (pi has neither), so both are
 * folded into the prompt text, exactly as in the pi and copilot adapters.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AGENT_INVOKE_TIMEOUT_MS, type AgentAdapter, type AgentInvokeOptions, type AgentInvokeResult } from './types.js';
import { writePromptToStdin } from './stdinPrompt.js';
import { composePrompt, truncateToBudget } from './promptText.js';

const execFileAsync = promisify(execFile);

/**
 * pi's tool names are lowercase with no scoping, and its built-in set is
 * read/write/edit/bash — so a scoped `Bash(git diff:*)` collapses to `bash`
 * (little-coder narrows *that* further with its own LITTLE_CODER_BASH_ALLOW
 * env var, which pipeline-worker leaves to the user's own setup) and `Grep`/
 * `Glob` have no equivalent and are dropped rather than invented.
 */
export function mapLittleCoderTools(allowedTools: string[]): string[] {
  const mapped = allowedTools
    .map((entry) => entry.replace(/\(.*$/, '').trim().toLowerCase())
    .map((name) => (name.startsWith('bash') ? 'bash' : name))
    .filter((name) => ['read', 'write', 'edit', 'bash'].includes(name));
  return [...new Set(mapped)];
}

/** Pulls the outermost JSON object out of a text answer that may have prose around it. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

export interface LittleCoderAdapterOptions {
  /** config.littleCoder.binary. */
  binary: string;
  /** config.littleCoder.maxPromptChars; 0 disables trimming. */
  maxPromptChars: number;
}

// fallow-ignore-next-line complexity
export function createLittleCoderAdapter(adapterOpts: LittleCoderAdapterOptions): AgentAdapter {
  return {
    async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
      const args: string[] = ['-p'];
      if (opts.model) args.push('--model', opts.model);
      const tools = opts.allowedTools?.length ? mapLittleCoderTools(opts.allowedTools) : [];
      if (tools.length > 0) args.push('--tools', tools.join(','));

      const prompt = truncateToBudget(composePrompt(opts), adapterOpts.maxPromptChars);
      const sessionName = `pipeline-worker-${randomUUID()}`;

      const start = Date.now();
      const invocation = execFileAsync(adapterOpts.binary, args, {
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
}
