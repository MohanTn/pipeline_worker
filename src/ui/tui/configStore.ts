/**
 * Dotted-path reads and writes over the raw settings file, for the TUI's
 * settings editor and setup wizard.
 *
 * Two rules shape this module:
 *
 * - It edits the *raw* file object, never a loaded PipelineWorkerConfig, so
 *   keys the user hand-added (or keys a newer version writes) survive a save
 *   untouched. Writing back a resolved config would silently bake every
 *   auto-detected value — build/lint/test, github.repo — into the file.
 * - Clearing a key removes it rather than writing its default, so the value
 *   goes back to being auto-detected/defaulted instead of being pinned to
 *   whatever the default happened to be on the day it was reset.
 */

import { readRawConfig, writeConfigFile, configFilePath } from '../../config/file.js';

export type ConfigValue = string | number | boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The value at 'gitlab.host', or undefined when any segment of the path is absent or not an object. */
export function getAtPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** A copy of `root` with `path` set, creating intermediate objects (and replacing non-object ones) as needed. */
export function setAtPath(root: Record<string, unknown>, path: string, value: ConfigValue): Record<string, unknown> {
  const keys = path.split('.');
  const copy: Record<string, unknown> = { ...root };
  let cursor = copy;
  for (let i = 0; i < keys.length - 1; i++) {
    const existing = cursor[keys[i]];
    const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
    cursor[keys[i]] = next;
    cursor = next;
  }
  cursor[keys[keys.length - 1]] = value;
  return copy;
}

/** A copy of `root` with `path` removed. Emptied parent objects are kept — an empty "gitlab": {} is harmless and keeps the file's shape recognizable. */
export function unsetAtPath(root: Record<string, unknown>, path: string): Record<string, unknown> {
  const keys = path.split('.');
  const copy: Record<string, unknown> = { ...root };
  let cursor = copy;
  for (let i = 0; i < keys.length - 1; i++) {
    const existing = cursor[keys[i]];
    if (!isPlainObject(existing)) return copy;
    const next = { ...existing };
    cursor[keys[i]] = next;
    cursor = next;
  }
  delete cursor[keys[keys.length - 1]];
  return copy;
}

/** The settings file as it is on disk right now, or an empty object when it does not exist yet. */
export function readSettingsFile(path: string = configFilePath()): Record<string, unknown> {
  return readRawConfig(path) ?? {};
}

export function saveSettingsFile(settings: Record<string, unknown>, path: string = configFilePath()): { ok: true } | { ok: false; error: string } {
  return writeConfigFile(settings, path);
}
