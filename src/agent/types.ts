/** Common interface both the Claude Code and Copilot CLI adapters implement. */

/**
 * Hard ceiling on a single headless agent invocation, shared by both
 * adapters. Conflict resolution and CI-fix turns run under acceptEdits with
 * full tool access (reading/editing multiple files, sometimes re-running
 * build/test commands), so they can legitimately take much longer than a
 * plain completion — 15 minutes gives that room while still bounding a hung
 * unattended run.
 */
export const AGENT_INVOKE_TIMEOUT_MS = 900_000;

export interface AgentInvokeOptions {
  /** The instruction given to the agent for this turn. */
  prompt: string;
  /**
   * Replaces the agent's default system prompt for this turn: one or two
   * sentences stating the job and nothing else, so a turn carries no
   * instructions it doesn't need (and, on a small local model, no context it
   * can't afford). Adapters whose CLI has no such flag fold it into the
   * prompt text instead (see promptText.ts).
   */
  systemPrompt?: string;
  /** Working directory the agent should operate in (the worktree). */
  cwd: string;
  /** Optional JSON schema the agent should conform its final answer to. */
  jsonSchema?: object;
  /** Optional path to an MCP config file (e.g. pipeline-worker's own `serve` registration) to load for this turn. */
  mcpConfigPath?: string;
  /** Optional permission mode override; adapters default to an auto-accept mode suitable for unattended runs. */
  permissionMode?: string;
  /**
   * Optional allowlist restricting which tools the agent may use this turn (e.g. `["Read", "Bash(git diff:*)"]`).
   * The claude adapter turns this into *both* `--tools` (which built-in tools exist at all for the turn) and
   * `--allowedTools` (which of them run without a permission prompt), so a turn given `["Read"]` has no way to
   * run a command even if its prompt asks for one. For adapters that can't scope tool access per invocation
   * (e.g. copilot, which always runs with full tool access), this is ignored — see that adapter's file comment.
   */
  allowedTools?: string[];
  /** Optional model override (e.g. "haiku"), for adapters that support per-invocation model selection. */
  model?: string;
}

/**
 * Best-effort token/cost telemetry for one agent invocation. Only adapters
 * whose CLI reports usage in its output format can fill this in (claude's
 * `--output-format json` envelope does; pi and copilot print modes expose
 * nothing, so their results simply omit it). Absence means "unknown", never
 * "zero" — display code must omit the figure rather than render 0.
 */
export interface AgentUsage {
  /** Prompt-side tokens, with any cache-creation/cache-read tokens folded in. */
  inputTokens?: number;
  /**
   * The share of inputTokens the model read back from the prompt cache instead
   * of processing fresh. Reported separately because it dominates a multi-turn
   * agent loop — every internal turn re-sends the whole prompt and re-counts it
   * — while billing at a fraction of fresh input, so a total alone makes a
   * cheap turn look enormous.
   */
  cacheReadTokens?: number;
  /** The share of inputTokens this turn wrote into the prompt cache. */
  cacheWriteTokens?: number;
  outputTokens?: number;
  /** input + output when both are known, else whichever side is known. */
  totalTokens?: number;
  costUsd?: number;
  numTurns?: number;
}

export interface AgentInvokeResult {
  /** The agent's final text answer (or, when jsonSchema was supplied, its raw JSON string). */
  text: string;
  /** The parsed structured payload, when the adapter's output format returns one. */
  raw?: unknown;
  /** Token/cost telemetry for this turn, when the adapter's CLI reports it (see AgentUsage). */
  usage?: AgentUsage;
  /**
   * Identifier for the underlying agent CLI's own session, so a user can look
   * up what it did later — `claude --resume <id>` or, for Copilot (which has
   * no way to report the session id it picked itself), the `--name` we chose
   * for it, resumable via `copilot --resume <id>`.
   */
  sessionId?: string;
  /** Wall-clock duration of this invocation in milliseconds. */
  durationMs?: number;
}

export interface AgentAdapter {
  invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult>;
}
