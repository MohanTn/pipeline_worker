/**
 * The TUI's settings layer: dotted-path edits over the raw file, and the
 * schema that turns those keys into an explained, typed form.
 *
 * The store tests use a real temp file rather than a mock — the whole point of
 * this layer is that it round-trips through the same on-disk format the loader
 * reads, and that unrelated keys survive an edit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAtPath, readSettingsFile, saveSettingsFile, setAtPath, unsetAtPath } from '../src/ui/tui/configStore.js';
import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  cycleValue,
  defaultValue,
  displayValue,
  effectiveValue,
  parseFieldInput,
  valueSource,
  type ConfigField,
} from '../src/ui/tui/configSchema.js';
import type { PipelineWorkerConfig } from '../src/types.js';

function field(path: string): ConfigField {
  const found = CONFIG_FIELDS.find((candidate) => candidate.path === path);
  assert.ok(found, `no schema entry for ${path}`);
  return found;
}

test('getAtPath reads nested keys and reports a missing branch as undefined', () => {
  const settings = { agent: 'claude', gitlab: { host: 'https://gitlab.com' } };
  assert.equal(getAtPath(settings, 'agent'), 'claude');
  assert.equal(getAtPath(settings, 'gitlab.host'), 'https://gitlab.com');
  assert.equal(getAtPath(settings, 'gitlab.token'), undefined);
  assert.equal(getAtPath(settings, 'github.token'), undefined);
  // A scalar mid-path must read as absent, not throw.
  assert.equal(getAtPath(settings, 'agent.nope'), undefined);
});

test('setAtPath creates missing intermediate objects without mutating the original', () => {
  const original = { agent: 'claude' };
  const next = setAtPath(original, 'gitlab.token', 'secret');
  assert.deepEqual(next, { agent: 'claude', gitlab: { token: 'secret' } });
  assert.deepEqual(original, { agent: 'claude' }, 'the input object must be left alone');
});

test('setAtPath replaces a non-object sitting where a section belongs', () => {
  assert.deepEqual(setAtPath({ gitlab: 'oops' }, 'gitlab.host', 'h'), { gitlab: { host: 'h' } });
});

test('unsetAtPath removes just that key, leaving its siblings and section in place', () => {
  const settings = { gitlab: { host: 'h', token: 't' }, agent: 'claude' };
  assert.deepEqual(unsetAtPath(settings, 'gitlab.token'), { gitlab: { host: 'h' }, agent: 'claude' });
  assert.deepEqual(settings.gitlab, { host: 'h', token: 't' }, 'the input object must be left alone');
});

test('unsetAtPath is a no-op for a path that was never set', () => {
  assert.deepEqual(unsetAtPath({ agent: 'claude' }, 'gitlab.token'), { agent: 'claude' });
});

test('a save round-trips through the real file format and preserves keys the TUI does not know about', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-tui-config-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ agent: 'claude', somethingFuture: { keep: true } }, null, 2));

    const settings = readSettingsFile(path);
    const next = setAtPath(settings, 'gitlab.host', 'https://gitlab.example.com');
    assert.deepEqual(saveSettingsFile(next, path), { ok: true });

    const reread = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    assert.equal(getAtPath(reread, 'gitlab.host'), 'https://gitlab.example.com');
    assert.deepEqual(reread.somethingFuture, { keep: true }, 'unknown keys must survive an edit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reading a settings file that does not exist yet yields an empty object rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-tui-config-'));
  try {
    assert.deepEqual(readSettingsFile(join(dir, 'absent.json')), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving into an unwritable location reports the reason instead of throwing', () => {
  // A regular file standing where the config directory should be: mkdir then
  // fails, which is the shape of the real failure (read-only HOME) the
  // settings editor has to survive and show.
  const dir = mkdtempSync(join(tmpdir(), 'pw-tui-config-'));
  try {
    writeFileSync(join(dir, 'blocked'), 'not a directory');
    const result = saveSettingsFile({}, join(dir, 'blocked', 'config.json'));
    assert.equal(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every schema field belongs to a declared group, so none can be invisible in the editor', () => {
  for (const entry of CONFIG_FIELDS) {
    assert.ok(CONFIG_GROUPS.includes(entry.group as (typeof CONFIG_GROUPS)[number]), `${entry.path} has unknown group ${entry.group}`);
  }
});

test('every non-auto-detected field resolves a built-in default, so the editor can always offer one', () => {
  for (const entry of CONFIG_FIELDS) {
    if (entry.autoDetected) continue;
    assert.notEqual(defaultValue(entry), undefined, `${entry.path} has no default in DEFAULT_CONFIG`);
  }
});

test('every enum field lists choices, and every boolean field lists none', () => {
  for (const entry of CONFIG_FIELDS) {
    if (entry.kind === 'enum') assert.ok(entry.choices && entry.choices.length > 1, `${entry.path} is an enum with no choices`);
    if (entry.kind === 'boolean') assert.equal(entry.choices, undefined);
  }
});

test('parseFieldInput accepts an enum case-insensitively and rejects anything else', () => {
  assert.deepEqual(parseFieldInput(field('mergeMethod'), 'SQUASH'), { ok: true, value: 'squash' });
  assert.equal(parseFieldInput(field('mergeMethod'), 'fast-forward').ok, false);
});

test('parseFieldInput accepts 0 for the numeric knobs where 0 means "unlimited", and rejects junk', () => {
  assert.deepEqual(parseFieldInput(field('reviewFilesPerTurn'), '0'), { ok: true, value: 0 });
  assert.equal(parseFieldInput(field('maxFixAttempts'), 'lots').ok, false);
  assert.equal(parseFieldInput(field('maxFixAttempts'), '-1').ok, false);
});

test('parseFieldInput keeps an empty check command verbatim, because "" means "skip this stage"', () => {
  // Trimming this to "unset" would resurrect auto-detection and silently run
  // the stage the user just turned off.
  assert.deepEqual(parseFieldInput(field('build'), ''), { ok: true, value: '' });
});

test('parseFieldInput trims a pasted secret, where surrounding whitespace is always an accident', () => {
  assert.deepEqual(parseFieldInput(field('gitlab.token'), '  glpat-xyz \n'), { ok: true, value: 'glpat-xyz' });
});

test('cycleValue toggles booleans and rotates enums, and declines to cycle free text', () => {
  assert.equal(cycleValue(field('review'), false), true);
  assert.equal(cycleValue(field('review'), true), false);
  assert.equal(cycleValue(field('forge'), 'gitlab'), 'github');
  assert.equal(cycleValue(field('forge'), 'github'), 'gitlab');
  assert.equal(cycleValue(field('branchPattern'), 'x'), undefined);
});

test('displayValue masks a set secret and never shows the token itself', () => {
  assert.equal(displayValue(field('gitlab.token'), 'glpat-supersecret'), '••••••••');
  assert.equal(displayValue(field('gitlab.token'), ''), '(required for gitlab)');
});

test('displayValue renders booleans as on/off and keeps a meaningful 0 visible', () => {
  assert.equal(displayValue(field('review'), true), 'on');
  assert.equal(displayValue(field('review'), false), 'off');
  assert.equal(displayValue(field('reviewFilesPerTurn'), 0), '0');
});

const BASE_CONFIG = {
  agent: 'claude',
  forge: 'gitlab',
  build: 'npm run build',
  github: { repo: 'me/thing', token: '', apiUrl: 'https://api.github.com' },
} as unknown as PipelineWorkerConfig;

test('valueSource distinguishes a value you chose from one detected from the repo and one that is just the default', () => {
  assert.equal(valueSource(field('agent'), { agent: 'claude' }, BASE_CONFIG), 'file');
  // build has no built-in default, so a resolved value can only have come from
  // toolchain detection.
  assert.equal(valueSource(field('build'), {}, BASE_CONFIG), 'auto');
  assert.equal(valueSource(field('github.repo'), {}, BASE_CONFIG), 'auto');
  assert.equal(valueSource(field('forge'), {}, BASE_CONFIG), 'default');
});

test('valueSource reports "file" even when the file happens to repeat the default', () => {
  // Otherwise a deliberate pin would read as an accident of the current defaults.
  assert.equal(valueSource(field('forge'), { forge: 'gitlab' }, BASE_CONFIG), 'file');
});

test('valueSource does not credit the file for a value the loader overrode', () => {
  // The first-run config file contains every key, including "github": {"repo": ""},
  // which the loader replaces with the repo detected from origin. Labelling that
  // row "file" would tell the user their empty string is what is in force.
  assert.equal(valueSource(field('github.repo'), { github: { repo: '' } }, BASE_CONFIG), 'auto');
});

test('effectiveValue reads the resolved config, including nested sections', () => {
  assert.equal(effectiveValue(field('github.repo'), BASE_CONFIG), 'me/thing');
});
