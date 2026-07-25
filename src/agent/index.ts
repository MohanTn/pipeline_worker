import type { PipelineWorkerConfig } from '../types.js';
import type { AgentAdapter } from './types.js';
import { createClaudeAdapter } from './claude.js';
import { copilotAdapter } from './copilot.js';
import { piAdapter } from './pi.js';
import { createLittleCoderAdapter } from './littleCoder.js';

/**
 * Picks the adapter named by the settings file's `agent`. Deliberately no
 * runtime fallback/interactive choice — the config names exactly one agent.
 * Adapters with settings of their own (claude's bare mode, little-coder's
 * binary and context budget) are constructed here from that same config, so no
 * agent call site has to thread config through to reach them.
 */
export function selectAgent(config: PipelineWorkerConfig): AgentAdapter {
  switch (config.agent) {
    case 'claude':
      return createClaudeAdapter({ bare: config.bareAgentMode });
    case 'copilot':
      return copilotAdapter;
    case 'pi':
      return piAdapter;
    case 'little-coder':
      return createLittleCoderAdapter(config.littleCoder);
  }
}
