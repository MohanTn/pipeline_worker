/**
 * Derives a GitLab namespace/project path from a local directory structure that
 * mirrors the GitLab group hierarchy.  Used when PIPELINE_WORKER_GITLAB_REPO_BASE
 * is set and no explicit projectId is configured, so the user can run
 * `pipeline-worker run` from any repo under the base without per-project config.
 */

import { relative, sep } from 'node:path';

/**
 * Converts a single path segment to lowercase kebab-case.
 * Handles both PascalCase ("RetailMediaPortal" → "retail-media-portal") and
 * already-hyphenated names ("Store-Media-Api" → "store-media-api").
 */
export function toKebabCase(segment: string): string {
  return segment
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Derives the GitLab project path from a local repo root and a base directory.
 *
 * @param repoBase - Local directory that mirrors the GitLab host root, e.g. '/home/user/REPO'
 * @param repoRoot - Absolute path of the local repo, e.g. '/home/user/REPO/Media/RetailMediaPortal/Instore/Store-Media-Api'
 * @returns GitLab project path, e.g. 'media/retail-media-portal/instore/store-media-api'
 *
 * @throws if repoRoot is not inside repoBase
 */
export function deriveProjectPath(repoBase: string, repoRoot: string): string {
  const rel = relative(repoBase, repoRoot);
  if (!rel || rel.startsWith('..')) {
    throw new Error(
      `Cannot derive GitLab project path: '${repoRoot}' is not inside repoBase '${repoBase}'. ` +
        `Set PIPELINE_WORKER_GITLAB_REPO_BASE (or gitlab.repoBase in .pipeline-worker.yml) ` +
        `to the local directory that mirrors the GitLab host namespace root.`,
    );
  }
  return rel.split(sep).map(toKebabCase).join('/');
}