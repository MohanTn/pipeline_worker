/** Common interface both the Claude Code and Copilot CLI adapters implement. */

export interface AgentInvokeOptions {
  /** The instruction given to the agent for this turn. */
  prompt: string;
  /** Working directory the agent should operate in (the worktree). */
  cwd: string;
  /** Optional JSON schema the agent should conform its final answer to. */
  jsonSchema?: object;
  /** Optional path to an MCP config file (e.g. pipeline-worker's own `serve` registration) to load for this turn. */
  mcpConfigPath?: string;
  /** Optional permission mode override; adapters default to an auto-accept mode suitable for unattended runs. */
  permissionMode?: string;
}

export interface AgentInvokeResult {
  /** The agent's final text answer (or, when jsonSchema was supplied, its raw JSON string). */
  text: string;
  /** The parsed structured payload, when the adapter's output format returns one. */
  raw?: unknown;
}

export interface AgentAdapter {
  invoke(opts: AgentInvokeOptions): Promise<AgentInvokeResult>;
}
