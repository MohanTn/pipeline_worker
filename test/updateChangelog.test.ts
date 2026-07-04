import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertChangelogEntry, updateChangelog } from '../src/workflow/updateChangelog.js';
import type { CapturedIntent } from '../src/types.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-changelog-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeIntent(overrides: Partial<CapturedIntent> = {}): CapturedIntent {
  return {
    intent: 'fix the thing',
    summary: 'Fix the broken thing',
    changeType: 'bugfix',
    branchSlug: 'fix-thing',
    commitMessage: 'fix: the thing',
    fileChanges: [{ file: 'src/thing.ts', summary: 'fixed it' }],
    risk: 'low',
    riskReason: 'isolated',
    testScenarios: ['thing works'],
    ...overrides,
  };
}

test('insertChangelogEntry creates [Unreleased] and the category section when neither exists', () => {
  const content = '# Changelog\n\nIntro text.\n';
  const result = insertChangelogEntry(content, 'Added', 'New widget');
  assert.match(result, /## \[Unreleased\]\n\n### Added\n\n- New widget/);
});

test('insertChangelogEntry adds a new category section under an existing [Unreleased] heading', () => {
  const content = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Existing feature\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- Old\n';
  const result = insertChangelogEntry(content, 'Fixed', 'Fixed a bug');
  assert.match(result, /## \[Unreleased\]\n\n### Fixed\n\n- Fixed a bug\n\n### Added\n\n- Existing feature/);
  // Older release section is untouched.
  assert.match(result, /## \[0\.1\.0\] - 2026-01-01\n\n### Added\n\n- Old/);
});

test('insertChangelogEntry prepends a bullet to an existing matching category', () => {
  const content = '## [Unreleased]\n\n### Added\n\n- Existing feature\n\n## [0.1.0] - 2026-01-01\n';
  const result = insertChangelogEntry(content, 'Added', 'New feature');
  const lines = result.split('\n');
  const addedIdx = lines.indexOf('### Added');
  assert.equal(lines[addedIdx + 2], '- New feature');
  assert.equal(lines[addedIdx + 3], '- Existing feature');
});

test('insertChangelogEntry does not touch categories under a past release when [Unreleased] is absent', () => {
  const content = '# Changelog\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- Old\n';
  const result = insertChangelogEntry(content, 'Added', 'New');
  const unreleasedIdx = result.indexOf('## [Unreleased]');
  const oldReleaseIdx = result.indexOf('## [0.1.0]');
  assert.ok(unreleasedIdx !== -1 && unreleasedIdx < oldReleaseIdx, 'new [Unreleased] section must be inserted before the past release');
});

test('updateChangelog creates CHANGELOG.md with a Keep a Changelog skeleton when the repo has none', () => {
  withTempDir((dir) => {
    updateChangelog(dir, makeIntent({ changeType: 'feature', summary: 'Add new widget' }));
    const content = readFileSync(join(dir, 'CHANGELOG.md'), 'utf-8');
    assert.match(content, /^# Changelog/);
    assert.match(content, /## \[Unreleased\]\n\n### Added\n\n- Add new widget/);
  });
});

test('updateChangelog maps changeType to the Keep a Changelog category (feature/bugfix/chore -> Added/Fixed/Changed)', () => {
  withTempDir((dir) => {
    updateChangelog(dir, makeIntent({ changeType: 'chore', summary: 'Tidy up deps' }));
    const content = readFileSync(join(dir, 'CHANGELOG.md'), 'utf-8');
    assert.match(content, /### Changed\n\n- Tidy up deps/);
  });
});

test('updateChangelog inserts into an existing CHANGELOG.md instead of overwriting it', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Prior entry\n');
    updateChangelog(dir, makeIntent({ changeType: 'bugfix', summary: 'Fix crash on startup' }));
    const content = readFileSync(join(dir, 'CHANGELOG.md'), 'utf-8');
    assert.match(content, /### Fixed\n\n- Fix crash on startup/);
    assert.match(content, /- Prior entry/);
  });
});
