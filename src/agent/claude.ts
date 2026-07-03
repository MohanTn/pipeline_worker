/**
 * Headless Claude Code adapter. Flags verified against the locally installed
 * `claude` CLI: `-p/--print`, `--output-format json`, `--permission-mode`,
 * `--json-schema`, `--mcp-config`, `--allowedTools`. There is no `--cwd`
 * flag — working directory is controlled by the spawned process's `cwd`
 * option.
 *
 * The prompt is written to the child's stdin rather than passed as a CLI
 * argument. Some invocations (e.g. watchPipeline.ts's CI-fix prompt, which
 * embeds failing-job logs) can carry many KB of text, and Linux caps a
 * single exec() argument at ~128KB (MAX_ARG_STRLEN); a large enough prompt
 * blows past that and execFile fails with E2BIG before `claude` even starts.
 * Piping via stdin (verified: `echo "..." | claude -p` reads the prompt from
 * stdin when the positional `prompt` argument is omitted) has no such limit.
 *
 * When the spawned CLI exits non-zero, the rejection we throw includes
 * **stdout in addition to stderr**. Under `--output-format json` Claude
 * frequently writes a structured `is_error: true` envelope to stdout, which
 * is where the real diagnostic lives; Node's default execFile rejection only
 * surfaces the command line + stderr, so without this the most useful failure
 * information is silently dropped.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from './types.js';
import { writePromptToStdin } from './stdinPrompt.js';

const execFileAsync = promisify(execFile);

const INVOKE_TIMEOUT_MS = 300_000;

/**
 * Tail-truncation cap for stdout/stderr in the rejection message. Mirrors
 * `watchPipeline.ts`'s `.slice(-4000)` so a verbose agent failure (e.g. an
 * error envelope that re-echoes the input diff) doesn't blow up the error
 * text that propagates through captureIntent and ultimately lands in the
 * CLI's stderr.
 */
const MAX_ERROR_OUTPUT_CHARS = 4000;

/** Subset of the rejection shape Node's promisified execFile produces. */
interface ExecErrorShape {
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

/**
 * Composes a human-readable message naming the cause (exit code or signal)
 * and including both stdout and stderr streams. Exported for unit testing so
 * callers building on top of this adapter can pin its behavior.
 */
/**
 * Renders one captured stream (`stdout` or `stderr`) as a single block, with
 * tail-truncation and a visible marker when the stream exceeded the cap.
 * Returns the empty string when there is nothing meaningful to show so the
 * caller can skip the block entirely.
 */
function formatStreamBlock(label: string, raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) return '';
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_ERROR_OUTPUT_CHARS) {
    return `--- ${label} ---\n${trimmed}`;
  }
  const dropped = trimmed.length - MAX_ERROR_OUTPUT_CHARS;
  return `--- ${label} ---\n[... ${dropped} chars truncated, showing last ${MAX_ERROR_OUTPUT_CHARS} ...]\n${trimmed.slice(-MAX_ERROR_OUTPUT_CHARS)}`;
}

export function formatProcessError(err: ExecErrorShape): string {
  let cause: string;
  if (err.signal) {
    cause = `killed by signal ${err.signal}`;
  } else if (err.code !== undefined && err.code !== null) {
    cause = `exited with code ${err.code}`;
  } else {
    cause = 'failed with no exit code or signal reported';
  }
  const lines: string[] = [`claude ${cause}.`];
  for (const [label, raw] of [['stdout', err.stdout], ['stderr', err.stderr]] as const) {
    const block = formatStreamBlock(label, raw);
    if (block) lines.push(block);
  }
  // Only fall through to the underlying Node error message when neither
  // captured stream has content — typical of spawn-time failures like
  // ENOENT, where the message is the only context we have.
  const hasStdout = !!(err.stdout && err.stdout.trim().length > 0);
  const hasStderr = !!(err.stderr && err.stderr.trim().length > 0);
  if (err.message && err.message.trim().length > 0 && !hasStdout && !hasStderr) {
    lines.push(`(underlying: ${err.message.trim()})`);
  }
  return lines.join('\n');
}

export const claudeAdapter: AgentAdapter = {
  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--permission-mode', opts.permissionMode ?? 'acceptEdits',
    ];
    if (opts.jsonSchema) {
      args.push('--json-schema', JSON.stringify(opts.jsonSchema));
    }
    if (opts.allowedTools?.length) {
      args.push('--allowedTools', ...opts.allowedTools);
    }
    if (opts.mcpConfigPath) {
      args.push('--mcp-config', opts.mcpConfigPath);
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }

    let stdout: string;
    try {
      const invocation = execFileAsync('claude', args, {
        cwd: opts.cwd,
        timeout: INVOKE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      // stdin is always a pipe here since stdio isn't overridden in execFileAsync's options.
      writePromptToStdin(invocation.child.stdin!, opts.prompt);
      const result = await invocation;
      stdout = result.stdout;
    } catch (rawErr) {
      const err = rawErr as ExecErrorShape;
      throw new Error(formatProcessError(err));
    }

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
