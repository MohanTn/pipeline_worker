import type { PipelineWorkerConfig } from '../types.js';
import type { AgentAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { copilotAdapter } from './copilot.js';
import { piAdapter } from './pi.js';

/**
 * Picks the adapter named by PIPELINE_WORKER_AGENT. Deliberately no runtime
 * fallback/interactive choice — the config names exactly one agent per repo.
 */
export function selectAgent(config: PipelineWorkerConfig): AgentAdapter {
  switch (config.agent) {
    case 'claude':
      return claudeAdapter;
    case 'copilot':
      return copilotAdapter;
    case 'pi':
      return piAdapter;
  }
}
