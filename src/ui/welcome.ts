/** Prints a one-time banner summarizing this run's configuration before any workflow stage starts. */

import { styleText } from 'node:util';
import { getGitUser } from '../git/commit.js';
import type { PipelineWorkerConfig } from '../types.js';

const RULE_WIDTH = 60;

export function repositoryUrl(config: PipelineWorkerConfig): string {
  if (config.forge === 'github') {
    return config.github.repo ? `https://github.com/${config.github.repo}` : '(not configured)';
  }
  return config.gitlab.host ? `${config.gitlab.host} (project ${config.gitlab.projectId})` : '(not configured)';
}

export function agentDescription(config: PipelineWorkerConfig): string {
  // Mirrors captureIntent.ts's INTENT_MODEL choice: only claude supports
  // per-invocation model selection today, so only claude has a "mode" to show.
  return config.agent === 'claude' ? 'claude (haiku for intent capture, default model for CI fixes)' : 'copilot';
}

export async function printWelcome(config: PipelineWorkerConfig, repoRoot: string): Promise<void> {
  const user = await getGitUser(repoRoot);
  const rows: Array<[string, string]> = [
    ['Agent', agentDescription(config)],
    ['Forge', config.forge],
    ['Repository', repositoryUrl(config)],
    ['Git user', user.name && user.email ? `${user.name} <${user.email}>` : '(not configured)'],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const rule = styleText('cyan', '─'.repeat(RULE_WIDTH));

  console.log(rule);
  console.log(styleText(['bold', 'cyan'], '  🚀 pipeline-worker'));
  console.log(rule);
  for (const [label, value] of rows) {
    console.log(`  ${styleText('cyan', label.padEnd(labelWidth))}  ${value}`);
  }
  console.log(rule);
}
