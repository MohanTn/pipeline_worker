/** Optional step (config.updateChangelog): after checks pass, add a bullet for this change under CHANGELOG.md's [Unreleased] section, creating the file if the target repo doesn't already keep one. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapturedIntent } from '../types.js';

const CHANGELOG_FILENAME = 'CHANGELOG.md';

/** Maps captureIntent.ts's changeType to the Keep a Changelog category it's recorded under. */
const CATEGORY_BY_CHANGE_TYPE: Record<CapturedIntent['changeType'], string> = {
  feature: 'Added',
  bugfix: 'Fixed',
  chore: 'Changed',
};

const NEW_CHANGELOG_HEADER =
  '# Changelog\n\n' +
  'All notable changes to this project are documented here. The format is based on ' +
  '[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to ' +
  '[Semantic Versioning](https://semver.org/).\n';

/** Builds the whole `## [Unreleased]` section from scratch, for when the changelog doesn't have one yet. */
function buildNewUnreleasedSection(category: string, entry: string): string[] {
  return ['## [Unreleased]', '', `### ${category}`, '', `- ${entry}`, ''];
}

/** Handles the case where `## [Unreleased]` doesn't exist at all: append it at EOF, or splice it in before the first existing `## ` heading. */
function insertMissingUnreleasedSection(lines: string[], category: string, entry: string): string[] {
  const firstH2Idx = lines.findIndex((l) => /^##\s/.test(l));
  const section = buildNewUnreleasedSection(category, entry);
  if (firstH2Idx === -1) {
    const needsBlankLine = lines.length > 0 && lines[lines.length - 1].trim() !== '';
    return [...lines, ...(needsBlankLine ? [''] : []), ...section];
  }
  lines.splice(firstH2Idx, 0, ...section);
  return lines;
}

/** Finds where the `## [Unreleased]` section ends: the next `## ` heading, or end of file. */
function findUnreleasedSectionEnd(lines: string[], unreleasedIdx: number): number {
  for (let i = unreleasedIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) return i;
  }
  return lines.length;
}

/** Inserts `- entry` under `### category` within the `[Unreleased]` section, creating the category heading if it's missing. */
// fallow-ignore-next-line complexity
function insertUnderCategory(lines: string[], unreleasedIdx: number, sectionEnd: number, category: string, entry: string): string[] {
  const categoryHeading = `### ${category}`;
  const categoryIdx = lines.findIndex((l, i) => i > unreleasedIdx && i < sectionEnd && l.trim() === categoryHeading);

  if (categoryIdx === -1) {
    let insertAt = unreleasedIdx + 1;
    while (insertAt < sectionEnd && lines[insertAt].trim() === '') insertAt++;
    lines.splice(insertAt, 0, categoryHeading, '', `- ${entry}`, '');
    return lines;
  }

  let insertAt = categoryIdx + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
  lines.splice(insertAt, 0, `- ${entry}`);
  return lines;
}

/**
 * Pure string transform (exported for unit testing): inserts a `- entry`
 * bullet under the `## [Unreleased]` -> `### category` section of `content`,
 * creating whichever of those two headings is missing. Section boundaries
 * are found structurally (next `## `/`### ` heading, or end of file) rather
 * than assuming any particular heading is the last one, so it works whether
 * [Unreleased] already has other categories, is the only `##` section, or
 * doesn't exist yet.
 */
export function insertChangelogEntry(content: string, category: string, entry: string): string {
  const lines = content.split('\n');
  const unreleasedIdx = lines.findIndex((l) => /^##\s*\[Unreleased\]/i.test(l));

  if (unreleasedIdx === -1) {
    return insertMissingUnreleasedSection(lines, category, entry).join('\n');
  }

  const sectionEnd = findUnreleasedSectionEnd(lines, unreleasedIdx);
  return insertUnderCategory(lines, unreleasedIdx, sectionEnd, category, entry).join('\n');
}

/** Writes the updated CHANGELOG.md into the worktree; callers stage it afterwards so it rides along in the same commit as the rest of the change. */
export function updateChangelog(worktreePath: string, intent: CapturedIntent): void {
  const path = join(worktreePath, CHANGELOG_FILENAME);
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : NEW_CHANGELOG_HEADER;
  const category = CATEGORY_BY_CHANGE_TYPE[intent.changeType];
  writeFileSync(path, insertChangelogEntry(existing, category, intent.summary));
}
