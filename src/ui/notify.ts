/**
 * Best-effort completion chime: plays a soft system notification sound when a
 * run settles (done / failed / escalated — not interrupted, where the user is
 * already at the keyboard). Never throws and never blocks: the player is
 * spawned detached with stdio ignored, and any failure degrades to the
 * terminal bell (this module lives under src/ui, the only layer allowed to
 * write to stdout). Disabled unless the workflow entry point enables it from
 * config (`PIPELINE_WORKER_COMPLETION_SOUND`), so library and test usage of
 * the UI layer stays silent.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

let enabled = false;

/** Called by the run/resume entry points with config.completionSound. */
export function setCompletionSound(on: boolean): void {
  enabled = on;
}

const FREEDESKTOP_CHIME = '/usr/share/sounds/freedesktop/stereo/complete.oga';
const CHIME_STATUSES = new Set(['done', 'failed', 'escalated']);

/** The soft system sounds each platform ships with, in preference order — each is tried until one spawns; empty when the platform has no known player. */
export function chimeCommands(platform: NodeJS.Platform, hasFreedesktopChime: boolean): Array<{ cmd: string; args: string[] }> {
  if (platform === 'darwin') return [{ cmd: 'afplay', args: ['/System/Library/Sounds/Glass.aiff'] }];
  if (platform === 'win32') {
    return [
      {
        cmd: 'powershell',
        args: ['-NoProfile', '-c', "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Notify.wav').PlaySync()"],
      },
    ];
  }
  if (platform === 'linux') {
    // freedesktop's "complete" chime via PulseAudio, with libcanberra (which
    // resolves the same event sound from the active theme) as the fallback
    // for machines without paplay.
    return [
      ...(hasFreedesktopChime ? [{ cmd: 'paplay', args: [FREEDESKTOP_CHIME] }] : []),
      { cmd: 'canberra-gtk-play', args: ['-i', 'complete'] },
    ];
  }
  return [];
}

/** Minimal surface of the spawned child this module touches, so tests can inject a fake. */
export type ChimeSpawner = (cmd: string, args: string[]) => { on(event: 'error', cb: () => void): unknown; unref(): void };

function defaultSpawner(cmd: string, args: string[]) {
  return spawn(cmd, args, { stdio: 'ignore', detached: true });
}

function bell(): void {
  // Last-resort audible cue when no player is available or spawning it failed.
  process.stdout.write('\u0007');
}

/** Spawns candidates[i], falling through to the next candidate when the player is missing, and to the bell when all are. */
function tryPlay(candidates: Array<{ cmd: string; args: string[] }>, spawner: ChimeSpawner, i = 0): void {
  if (i >= candidates.length) {
    bell();
    return;
  }
  try {
    const child = spawner(candidates[i].cmd, candidates[i].args);
    child.on('error', () => tryPlay(candidates, spawner, i + 1));
    child.unref();
  } catch {
    tryPlay(candidates, spawner, i + 1);
  }
}

/**
 * Fire-and-forget: called by endRun for every terminal status; plays only
 * when enabled, on a real terminal (CI, tests, and piped output stay silent),
 * and for a status that warrants it.
 */
export function maybeChime(status: string, spawner: ChimeSpawner = defaultSpawner, isTty: boolean = process.stdout.isTTY === true): void {
  if (!enabled || !isTty || !CHIME_STATUSES.has(status)) return;
  tryPlay(chimeCommands(process.platform, existsSync(FREEDESKTOP_CHIME)), spawner);
}
