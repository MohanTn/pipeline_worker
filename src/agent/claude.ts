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
import { AGENT_INVOKE_TIMEOUT_MS, type AgentAdapter, type AgentInvokeOptions, type AgentInvokeResult, type AgentUsage } from './types.js';
import { writePromptToStdin } from './stdinPrompt.js';

const execFileAsync = promisify(execFile);

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

function describeCause(err: ExecErrorShape): string {
  if (err.signal) return `killed by signal ${err.signal}`;
  if (err.code !== undefined && err.code !== null) return `exited with code ${err.code}`;
  return 'failed with no exit code or signal reported';
}

function hasMeaningfulOutput(err: ExecErrorShape): boolean {
  return !!(err.stdout && err.stdout.trim().length > 0) || !!(err.stderr && err.stderr.trim().length > 0);
}

/**
 * Falls back to the underlying Node error message only when neither captured
 * stream has content — typical of spawn-time failures like ENOENT, where the
 * message is the only context we have.
 */
function underlyingMessageLine(err: ExecErrorShape): string | undefined {
  if (err.message && err.message.trim().length > 0 && !hasMeaningfulOutput(err)) {
    return `(underlying: ${err.message.trim()})`;
  }
  return undefined;
}

export function formatProcessError(err: ExecErrorShape): string {
  const lines: string[] = [`claude ${describeCause(err)}.`];
  for (const [label, raw] of [['stdout', err.stdout], ['stderr', err.stderr]] as const) {
    const block = formatStreamBlock(label, raw);
    if (block) lines.push(block);
  }
  const underlying = underlyingMessageLine(err);
  if (underlying) lines.push(underlying);
  return lines.join('\n');
}

// fallow-ignore-next-line complexity
function buildClaudeArgs(opts: AgentInvokeOptions): string[] {
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
  return args;
}

/**
 * Spawns `claude` and pipes the prompt to its stdin. Kept as one atomic
 * function: `.child.stdin` must be grabbed synchronously between creating
 * the execFileAsync invocation and awaiting it, so this sequence can't be
 * split across function boundaries without breaking that ordering.
 */
async function runClaudeProcess(args: string[], opts: AgentInvokeOptions): Promise<string> {
  try {
    const invocation = execFileAsync('claude', args, {
      cwd: opts.cwd,
      timeout: AGENT_INVOKE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    // stdin is always a pipe here since stdio isn't overridden in execFileAsync's options.
    writePromptToStdin(invocation.child.stdin!, opts.prompt);
    const result = await invocation;
    return result.stdout;
  } catch (rawErr) {
    const err = rawErr as ExecErrorShape;
    throw new Error(formatProcessError(err));
  }
}

interface ClaudeEnvelope {
  result?: string;
  session_id?: string;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Extracts best-effort token telemetry from the CLI's envelope. Cache
 * creation/read tokens are folded into inputTokens — they are prompt-side
 * spend either way, and one figure is what the per-step display needs. Any
 * malformed or missing field degrades to undefined, never a throw: usage is
 * decoration, and a CLI version that reshapes this part of the envelope must
 * not break the run.
 */
function parseUsage(parsed: ClaudeEnvelope): AgentUsage | undefined {
  const rawUsage = parsed.usage;
  const input = asCount(rawUsage?.input_tokens);
  const cacheCreation = asCount(rawUsage?.cache_creation_input_tokens);
  const cacheRead = asCount(rawUsage?.cache_read_input_tokens);
  const inputTokens = input === undefined && cacheCreation === undefined && cacheRead === undefined ? undefined : (input ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0);
  const outputTokens = asCount(rawUsage?.output_tokens);
  const totalTokens = inputTokens === undefined && outputTokens === undefined ? undefined : (inputTokens ?? 0) + (outputTokens ?? 0);
  const costUsd = asCount(parsed.total_cost_usd);
  const numTurns = asCount(parsed.num_turns);
  if (totalTokens === undefined && costUsd === undefined && numTurns === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens, costUsd, numTurns };
}

function parseClaudeResult(stdout: string, start: number): AgentInvokeResult {
  try {
    // duration_ms/session_id come straight from the CLI's own JSON envelope
    // (see the module comment's `claude -p --output-format json` sample);
    // falling back to our own wall-clock reading only covers the
    // never-observed case where that envelope omits duration_ms.
    const parsed = JSON.parse(stdout) as ClaudeEnvelope;
    return {
      text: parsed.result ?? stdout,
      raw: parsed,
      sessionId: parsed.session_id,
      durationMs: parsed.duration_ms ?? Date.now() - start,
      usage: parseUsage(parsed),
    };
  } catch {
    // --output-format json should always produce parseable JSON; fall back
    // to the raw stream rather than throwing, since the invocation itself succeeded.
    return { text: stdout, durationMs: Date.now() - start };
  }
}

export const claudeAdapter: AgentAdapter = {
  async invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const args = buildClaudeArgs(opts);
    const start = Date.now();
    const stdout = await runClaudeProcess(args, opts);
    return parseClaudeResult(stdout, start);
  },
};
