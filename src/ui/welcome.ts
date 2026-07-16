/** Prints this run's configuration (agent, forge, repository, git user) before any workflow stage starts. */

import { getGitUser } from "../git/commit.js";
import { boxBullet } from "./format.js";
import type { PipelineWorkerConfig } from "../types.js";

export function repositoryUrl(config: PipelineWorkerConfig): string {
  if (config.forge === "github") {
    return config.github.repo
      ? `https://github.com/${config.github.repo}`
      : "(not configured)";
  }
  return config.gitlab.host
    ? `${config.gitlab.host} (project ${config.gitlab.projectId})`
    : "(not configured)";
}

export function agentDescription(config: PipelineWorkerConfig): string {
  // claude and pi support per-invocation model selection; copilot does not.
  if (config.agent === "claude" || config.agent === "pi") {
    return `${config.agent} (${config.intentModel} for intent capture, default model for CI fixes)`;
  }
  return "copilot";
}

export async function printWelcome(
  config: PipelineWorkerConfig,
  repoRoot: string,
): Promise<void> {
  const user = await getGitUser(repoRoot);
  const rows: Array<[string, string]> = [
    ["Agent", agentDescription(config)],
    ["Forge", config.forge],
    ["Repository", repositoryUrl(config)],
    [
      "Git User",
      user.name && user.email
        ? `${user.name} <${user.email}>`
        : "(not configured)",
    ],
  ];

  for (const [label, value] of rows) {
    console.log(boxBullet(label, value));
  }
  console.log("");
}
