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
  // copilot is the one adapter with no per-invocation model selection, so it
  // is the only one whose line can't name a model. Every other agent — and
  // any added later — reports the intent model it was configured with.
  if (config.agent === "copilot") return "copilot";
  // intentModel defaults to '' on pi/little-coder (see config/loader.ts) —
  // named as "agent default" rather than printing an empty pair of parens.
  const model = config.intentModel || "agent default";
  return `${config.agent} (${model} for intent capture and CI fixes)`;
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
