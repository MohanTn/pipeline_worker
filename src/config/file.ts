/**
 * The on-disk settings file — `~/.config/pipeline-worker/config.json`
 * (`$XDG_CONFIG_HOME/pipeline-worker/config.json` when that is set), which is
 * pipeline-worker's *only* configuration source: there are no
 * PIPELINE_WORKER_* environment variables and no per-repo config file.
 *
 * Pure IO, deliberately knowing nothing about the config's shape — loader.ts
 * owns the defaults and the parsing. Read/write never throw (the loader's
 * never-throw contract): a missing file reads as "no settings", an unreadable
 * or malformed one degrades to a warning plus the built-in defaults, and a
 * failed first-run write is a warning too, not a dead run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory holding config.json — respects XDG_CONFIG_HOME, else ~/.config. */
export function configDir(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdgHome && xdgHome.length > 0 ? xdgHome : join(homedir(), '.config'), 'pipeline-worker');
}

export function configFilePath(): string {
  return join(configDir(), 'config.json');
}

/**
 * The settings file's parsed contents, or undefined when it does not exist
 * (the caller's cue to create it). A file that exists but cannot be read or
 * is not a JSON object reads as an empty object — every value then falls back
 * to its built-in default — so a stray character never blocks a run.
 */
// fallow-ignore-next-line complexity
export function readRawConfig(path: string = configFilePath()): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`Warning: ${path} is not a JSON object — ignoring it and using defaults.`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to read ${path}: ${message}. Using defaults.`);
    return {};
  }
}

/**
 * Serializes `contents` over the settings file. Returns the failure reason
 * instead of throwing (this module's never-throw contract) so an interactive
 * caller — the TUI's settings editor — can show "could not save: <why>" in
 * place of the edit, rather than silently appearing to have saved.
 */
export function writeConfigFile(contents: unknown, path: string = configFilePath()): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf-8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Writes the built-in defaults to `path` on first run, so the user has a
 * complete, editable file to fill in (host, tokens, project id) instead of
 * having to author one from the README. Best-effort: a read-only HOME warns
 * and the run continues on defaults.
 */
export function writeDefaultConfig(contents: unknown, path: string = configFilePath()): void {
  const result = writeConfigFile(contents, path);
  if (result.ok) {
    console.error(`pipeline-worker: created ${path} — edit it to configure forge, tokens, and check commands.`);
    return;
  }
  console.error(`Warning: failed to create ${path}: ${result.error}. Using defaults for this run.`);
}
