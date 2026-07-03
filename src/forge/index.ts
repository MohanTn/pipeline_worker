import type { PipelineWorkerConfig } from '../types.js';
import type { ForgeClient } from './types.js';
import { createGitlabForge } from './gitlab.js';
import { createGithubForge } from './github.js';

/** Picks the forge named in config (PIPELINE_WORKER_FORGE). No runtime fallback. */
export function createForge(config: PipelineWorkerConfig): ForgeClient {
  switch (config.forge) {
    case 'gitlab':
      return createGitlabForge(config);
    case 'github':
      return createGithubForge(config);
  }
}
