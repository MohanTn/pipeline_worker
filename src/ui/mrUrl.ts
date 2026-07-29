/**
 * Where a run's MR/PR lives on the web.
 *
 * Runs recorded since RunState gained `mrUrl` carry the forge's own URL, which
 * is the only value guaranteed right for a self-hosted GitLab or a GitHub
 * Enterprise install. Older state files have nothing but an iid, so the URL is
 * rebuilt from the settings file — best-effort, and deliberately `undefined`
 * rather than a plausible-looking guess when the settings cannot produce a
 * real link (a numeric GitLab project id has no web path, an unconfigured
 * repo has no host).
 */

import type { PipelineWorkerConfig, RunState } from '../types.js';

/** The part of a run this module needs — a full RunState satisfies it. */
export type MrRef = Pick<RunState, 'mrIid' | 'mrUrl'>;

function withScheme(host: string): string {
  const trimmed = host.replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** api.github.com serves github.com; a GHE api url (https://ghe.example/api/v3) serves its own origin. */
function githubWebBase(apiUrl: string): string | undefined {
  try {
    const url = new URL(withScheme(apiUrl));
    return url.hostname === 'api.github.com' ? 'https://github.com' : url.origin;
  } catch {
    return undefined;
  }
}

function githubMrUrl(config: PipelineWorkerConfig, iid: number): string | undefined {
  if (!config.github.repo) return undefined;
  const base = githubWebBase(config.github.apiUrl);
  return base ? `${base}/${config.github.repo}/pull/${iid}` : undefined;
}

function gitlabMrUrl(config: PipelineWorkerConfig, iid: number): string | undefined {
  const { host, projectId } = config.gitlab;
  // A numeric project id names no web path, and GitLab has no stable
  // id-based merge-request route to fall back on — better no link than a 404.
  if (!host || typeof projectId !== 'string' || projectId === '' || /^\d+$/.test(projectId)) return undefined;
  return `${withScheme(host)}/${projectId.replace(/^\/+|\/+$/g, '')}/-/merge_requests/${iid}`;
}

/** The recorded URL, else one rebuilt from `config`, else undefined when this run has no MR/PR (or no way to address it). */
export function resolveMrUrl(state: MrRef, config?: PipelineWorkerConfig): string | undefined {
  if (state.mrUrl) return state.mrUrl;
  if (state.mrIid === undefined || !config) return undefined;
  return config.forge === 'github' ? githubMrUrl(config, state.mrIid) : gitlabMrUrl(config, state.mrIid);
}
