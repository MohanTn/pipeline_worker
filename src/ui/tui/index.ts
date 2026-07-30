/**
 * Wiring: builds the TUI's home screen against the real repo, config file, and
 * workflow commands, and starts the app loop.
 *
 * Every view takes its outside world as an injected interface (SettingsIo,
 * SessionsIo, RunIo); this module is the only place those are bound to real
 * filesystem and workflow calls, which is what keeps the views unit-testable.
 */

import { TuiApp } from './app.js';
import { Screen } from './screen.js';
import { seg, type Line } from './line.js';
import { readSettingsFile, saveSettingsFile } from './configStore.js';
import { MenuView, type MenuItem } from './views/menu.js';
import { SettingsView, type SettingsIo } from './views/settings.js';
import { SetupView } from './views/setup.js';
import { SessionsView, type SessionsIo } from './views/sessions.js';
import { RunView, type RunIo } from './views/run.js';
import { loadConfig } from '../../config/loader.js';
import { configFilePath } from '../../config/file.js';
import { listRunStates } from '../../state/runState.js';
import { runWorkflow } from '../../workflow/orchestrate.js';
import { resumeRun, reviewBranch } from '../../workflow/runCommands.js';
import { agentDescription, repositoryUrl } from '../welcome.js';
import { resolveMrUrl } from '../mrUrl.js';
import type { PipelineWorkerConfig } from '../../types.js';
import type { View } from './view.js';

function settingsIo(repoRoot: string): SettingsIo {
  return {
    read: () => readSettingsFile(),
    save: (settings) => saveSettingsFile(settings),
    resolve: () => loadConfig(repoRoot),
  };
}

/** loadConfig is best-effort here: a repo whose settings cannot be read still browses its sessions, just without rebuilt MR/PR links. */
function optionalConfig(repoRoot: string): PipelineWorkerConfig | undefined {
  try {
    return loadConfig(repoRoot);
  } catch {
    return undefined;
  }
}

function sessionsIo(repoRoot: string, screen: Screen): SessionsIo {
  return {
    list: () => listRunStates(repoRoot),
    resume: async (branch) => {
      await resumeRun(repoRoot, { branch });
    },
    review: async (branch) => {
      await reviewBranch(repoRoot, { branch });
    },
    // Settings are only read for a run from before RunState.mrUrl existed.
    mrUrl: (state) => state.mrUrl ?? (state.mrIid !== undefined ? resolveMrUrl(state, optionalConfig(repoRoot)) : undefined),
    copy: (text) => screen.copyToClipboard(text),
  };
}

function runIo(repoRoot: string): RunIo {
  return { start: (options) => runWorkflow(repoRoot, options) };
}

/** The banner above the home menu: what this repo is currently configured to do, so a misconfiguration is visible before anything runs. */
export function homeHeader(repoRoot: string): Line[] {
  let summary: Line[];
  try {
    const config = loadConfig(repoRoot);
    summary = [
      [seg('agent   ', { role: 'overlay1' }), seg(agentDescription(config), { role: 'subtext0' })],
      [seg('forge   ', { role: 'overlay1' }), seg(config.forge, { role: 'subtext0' }), seg(`  ${repositoryUrl(config)}`, { role: 'overlay1' })],
      [seg('config  ', { role: 'overlay1' }), seg(configFilePath(), { role: 'overlay1' })],
    ];
  } catch (error) {
    // loadConfig never throws by contract, but the home screen is the one
    // place a user would look to find out that it did.
    summary = [[seg(`config could not be read: ${error instanceof Error ? error.message : String(error)}`, { role: 'red' })]];
  }
  return [[seg(repoRoot, { bold: true })], ...summary, []];
}

export function buildHome(repoRoot: string, screen: Screen): View {
  const items: MenuItem[] = [
    {
      label: 'Run workflow',
      description: 'Capture the current diff and drive it to a green merge request',
      onSelect: () => ({ type: 'push', view: new RunView(runIo(repoRoot)) }),
    },
    {
      label: 'Sessions',
      description: "Browse this repo's runs; resume or review one",
      onSelect: () => ({ type: 'push', view: new SessionsView(sessionsIo(repoRoot, screen)) }),
    },
    {
      label: 'Settings',
      description: 'Edit every setting, with an explanation of what each one does',
      onSelect: () => ({ type: 'push', view: new SettingsView(settingsIo(repoRoot)) }),
    },
    {
      label: 'Setup guide',
      description: 'Walk through forge, credentials, and agent — start here on a new machine',
      onSelect: () => ({ type: 'push', view: new SetupView(settingsIo(repoRoot)) }),
    },
    {
      label: 'Quit',
      description: 'Leave the TUI',
      onSelect: () => ({ type: 'quit' }),
    },
  ];
  return new MenuView('home', items, homeHeader(repoRoot));
}

/**
 * Bare `pipeline-worker` on a terminal opens the TUI; with any argument, or
 * when either stream is redirected, it stays the plain `run` command it has
 * always been. Both streams matter: the TUI paints to stdout and reads raw
 * keys from stdin, so a piped invocation on either side has to fall through to
 * the non-interactive path (CI, `pipeline-worker | tee`, a wrapper script).
 *
 * Lives here rather than in cli.ts so it is testable — importing cli.ts runs
 * commander against the test runner's own argv.
 */
export function shouldOpenTui(argv: readonly string[], stdinIsTty: boolean, stdoutIsTty: boolean): boolean {
  return argv.length === 0 && stdinIsTty && stdoutIsTty;
}

/** Entry point for `pipeline-worker tui`. Resolves once the terminal has been restored. */
export async function startTui(repoRoot: string): Promise<void> {
  // One Screen for both: the sessions browser's copy key writes OSC 52 to the
  // same stream the app paints on, so it must not open a second one.
  const screen = new Screen();
  await new TuiApp(buildHome(repoRoot, screen), screen).run();
}
