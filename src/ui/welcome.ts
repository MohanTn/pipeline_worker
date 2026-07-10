/** Prints a one-time banner summarizing this run's configuration before any workflow stage starts. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from "node:util";
import { getGitUser } from "../git/commit.js";
import { boxHeader, boxBullet, boxBottom, boxTop } from "./format.js";
import type { PipelineWorkerConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { name: string; version: string };

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

  console.log(boxTop());
  const title = `🚀 PIPELINE WORKER v${pkg.version} • By Mohan Talkad`;
  const padding = Math.max(0, 98 - title.length);
  const titleLine = `│ ${styleText("bold", title)}${" ".repeat(padding)}│`;
  console.log(titleLine);
  console.log(boxBottom());

  for (const [label, value] of rows) {
    console.log(boxBullet(label, value, 2));
  }

  console.log("");
}
