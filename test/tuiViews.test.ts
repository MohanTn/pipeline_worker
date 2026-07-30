/**
 * The TUI's screens, driven by keystrokes against injected fakes.
 *
 * Each view takes its outside world as an interface (SettingsIo, SessionsIo,
 * RunIo), so these tests type into the settings editor and the setup wizard
 * and assert on what would have been written to the config file — no HOME, no
 * repo, no terminal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { plainText, type Line } from '../src/ui/tui/line.js';
import { getAtPath } from '../src/ui/tui/configStore.js';
import { SettingsView, buildRows, type SettingsIo } from '../src/ui/tui/views/settings.js';
import { SetupView, applyAnswers, wizardSteps } from '../src/ui/tui/views/setup.js';
import { SessionsView, SessionDetailView, type SessionsIo } from '../src/ui/tui/views/sessions.js';
import { RunView, type RunIo } from '../src/ui/tui/views/run.js';
import { MenuView } from '../src/ui/tui/views/menu.js';
import type { Key } from '../src/ui/tui/keys.js';
import type { Action, View } from '../src/ui/tui/view.js';
import type { RunSession } from '../src/state/runState.js';
import type { PipelineWorkerConfig } from '../src/types.js';

const SIZE = { columns: 90, rows: 40 };

/** The left half of chrome.ts's selection bar — how a rendered row says "the cursor is here". */
const SELECTED = '▐';

function textOf(view: View): string[] {
  return view.render(SIZE).body.map((line: Line) => plainText(line));
}

/** Feeds a string as individual character keys, the way a user types into a field. */
function type(view: View, text: string): void {
  for (const ch of text) void view.onKey({ name: 'char', value: ch });
}

function press(view: View, ...keys: Key[]): Action {
  let last: Action = { type: 'none' };
  for (const key of keys) last = view.onKey(key) as Action;
  return last;
}

/**
 * A settings file plus a resolver that mimics loader.ts: file value wins,
 * otherwise the fallback config. Enough to exercise the editor's file/auto/
 * default distinction without the real loader touching disk.
 */
function fakeSettingsIo(initial: Record<string, unknown> = {}, resolved: Partial<PipelineWorkerConfig> = {}): SettingsIo & { settings: Record<string, unknown>; saves: number } {
  const base = {
    agent: 'claude',
    forge: 'gitlab',
    bareAgentMode: true,
    autoMergeOnGreen: true,
    review: false,
    mergeMethod: 'squash',
    maxFixAttempts: 5,
    branchPattern: 'pipeline-worker/{name}',
    build: 'npm run build',
    gitlab: { host: '', projectId: 0, token: '' },
    github: { repo: '', token: '', apiUrl: 'https://api.github.com' },
    littleCoder: { binary: 'little-coder', maxPromptChars: 12000 },
    ...resolved,
  } as unknown as PipelineWorkerConfig;

  const io = {
    settings: initial,
    saves: 0,
    read: () => io.settings,
    save: (next: Record<string, unknown>) => {
      io.settings = next;
      io.saves += 1;
      return { ok: true } as const;
    },
    // Merge the file over the base, so an edit is visible on the next resolve
    // exactly as it would be after loadConfig re-reads the file.
    resolve: () => {
      const merged: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
      for (const [key, value] of Object.entries(io.settings)) {
        const existing = merged[key];
        merged[key] =
          value !== null && typeof value === 'object' && !Array.isArray(value) && existing !== null && typeof existing === 'object'
            ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
            : value;
      }
      return merged as unknown as PipelineWorkerConfig;
    },
  };
  return io;
}

/** Moves the settings cursor onto a field by path, failing the test if it is unreachable. */
function focusField(view: SettingsView, path: string): void {
  const rows = buildRows();
  const target = rows.findIndex((row) => row.kind === 'field' && row.field.path === path);
  assert.ok(target >= 0, `no row for ${path}`);
  for (let i = 0; i < rows.length + 1; i++) {
    const rendered = view.render(SIZE).body.map(plainText);
    if (rendered.some((line) => line.startsWith(SELECTED) && line.includes((rows[target] as { field: { label: string } }).field.label))) return;
    press(view, { name: 'down' });
  }
  assert.fail(`could not focus ${path}`);
}

test('the settings editor lists every group as a heading with its fields underneath', () => {
  const rows = buildRows();
  assert.ok(rows.some((row) => row.kind === 'group' && row.label === 'GitLab'));
  assert.ok(rows.some((row) => row.kind === 'field' && row.field.path === 'gitlab.token'));
  // A heading is never the first thing the cursor lands on.
  assert.equal(rows[0].kind, 'group');
});

test('enter toggles a boolean and writes it straight through to the settings file', () => {
  const io = fakeSettingsIo();
  const view = new SettingsView(io);
  focusField(view, 'review');
  press(view, { name: 'enter' });
  assert.equal(getAtPath(io.settings, 'review'), true);
  assert.equal(io.saves, 1);
  assert.ok(textOf(view).some((line) => line.includes('saved')));
});

test('enter cycles an enum through its choices', () => {
  const io = fakeSettingsIo();
  const view = new SettingsView(io);
  focusField(view, 'forge');
  press(view, { name: 'enter' });
  assert.equal(getAtPath(io.settings, 'forge'), 'github');
  press(view, { name: 'enter' });
  assert.equal(getAtPath(io.settings, 'forge'), 'gitlab');
});

test('enter on a text field opens an editor, and enter again saves what was typed', () => {
  const io = fakeSettingsIo();
  const view = new SettingsView(io);
  focusField(view, 'branchPattern');
  press(view, { name: 'enter' });
  press(view, { name: 'ctrl', value: 'u' });
  type(view, '{type}/{name}');
  assert.ok(textOf(view).some((line) => line.includes('branchPattern = {type}/{name}')), 'the open editor shows what is being typed');
  press(view, { name: 'enter' });
  assert.equal(getAtPath(io.settings, 'branchPattern'), '{type}/{name}');
});

test('escape abandons an open edit without saving', () => {
  const io = fakeSettingsIo();
  const view = new SettingsView(io);
  focusField(view, 'branchPattern');
  press(view, { name: 'enter' });
  type(view, 'junk');
  press(view, { name: 'escape' });
  assert.equal(io.saves, 0);
  assert.equal(getAtPath(io.settings, 'branchPattern'), undefined);
});

test('an invalid number keeps the editor open with the reason, rather than saving junk', () => {
  const io = fakeSettingsIo();
  const view = new SettingsView(io);
  focusField(view, 'maxFixAttempts');
  press(view, { name: 'enter' });
  press(view, { name: 'ctrl', value: 'u' });
  type(view, 'many');
  press(view, { name: 'enter' });
  assert.equal(io.saves, 0);
  assert.ok(textOf(view).some((line) => line.includes('expected a number')));
});

test('editing a secret opens an empty field, so the stored token is never echoed onto the screen', () => {
  const io = fakeSettingsIo({ gitlab: { token: 'glpat-supersecret' } });
  const view = new SettingsView(io);
  focusField(view, 'gitlab.token');
  const before = textOf(view).join('\n');
  assert.ok(!before.includes('glpat-supersecret'), 'the row must show the mask, not the token');
  press(view, { name: 'enter' });
  assert.ok(!textOf(view).join('\n').includes('glpat-supersecret'), 'the editor must not pre-fill the token');
});

test('d clears a field back to unset, handing the value to auto-detection rather than pinning the default', () => {
  const io = fakeSettingsIo({ build: 'make all' });
  const view = new SettingsView(io);
  focusField(view, 'build');
  press(view, { name: 'char', value: 'd' });
  assert.equal(getAtPath(io.settings, 'build'), undefined, 'the key must be removed, not rewritten with a default');
});

test('? toggles the help paragraph for the focused field', () => {
  const io = fakeSettingsIo();
  const view = new SettingsView(io);
  focusField(view, 'bareAgentMode');
  assert.ok(textOf(view).some((line) => line.includes('ANTHROPIC_API_KEY')), 'help is shown by default');
  press(view, { name: 'char', value: '?' });
  assert.ok(!textOf(view).some((line) => line.includes('ANTHROPIC_API_KEY')));
});

test('q leaves the settings editor, but only when no edit is open', () => {
  const io = fakeSettingsIo();
  const view = new SettingsView(io);
  focusField(view, 'branchPattern');
  press(view, { name: 'enter' });
  // 'q' is a legal character in a branch pattern.
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'none' });
  press(view, { name: 'escape' });
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'pop' });
});

test('a failing save is reported on screen instead of silently appearing to have worked', () => {
  const io = fakeSettingsIo();
  const failing: SettingsIo = { ...io, save: () => ({ ok: false, error: 'EROFS: read-only file system' }) };
  const view = new SettingsView(failing);
  focusField(view, 'review');
  press(view, { name: 'enter' });
  assert.ok(textOf(view).some((line) => line.includes('could not save') && line.includes('EROFS')));
});

test('the wizard asks only about the forge you picked', () => {
  const gitlabPaths = wizardSteps({ forge: 'gitlab', agent: 'claude' }).map((step) => step.path);
  assert.ok(gitlabPaths.includes('gitlab.host'));
  assert.ok(gitlabPaths.includes('gitlab.token'));
  assert.ok(!gitlabPaths.includes('github.token'));

  const githubPaths = wizardSteps({ forge: 'github', agent: 'claude' }).map((step) => step.path);
  assert.ok(githubPaths.includes('github.repo'));
  assert.ok(githubPaths.includes('github.token'));
  assert.ok(!githubPaths.includes('gitlab.host'));
});

test('the wizard raises the --bare credentials trap only for claude', () => {
  assert.ok(wizardSteps({ forge: 'gitlab', agent: 'claude' }).some((step) => step.path === 'bareAgentMode'));
  assert.ok(!wizardSteps({ forge: 'gitlab', agent: 'copilot' }).some((step) => step.path === 'bareAgentMode'));
});

test('applyAnswers writes the answers and leaves every other key alone', () => {
  const before = { plainOutput: true, gitlab: { repoBase: '~/work' } };
  const after = applyAnswers(before, { forge: 'github', 'github.token': 'ghp-x' });
  assert.equal(getAtPath(after, 'forge'), 'github');
  assert.equal(getAtPath(after, 'github.token'), 'ghp-x');
  assert.equal(getAtPath(after, 'plainOutput'), true);
  assert.equal(getAtPath(after, 'gitlab.repoBase'), '~/work');
});

test('walking the wizard to the end writes exactly the answers given', () => {
  const io = fakeSettingsIo();
  const view = new SetupView(io);
  press(view, { name: 'enter' }); // leave the intro

  // forge: default cursor sits on the current value (gitlab); move to github.
  press(view, { name: 'down' }, { name: 'enter' });
  // agent: keep claude.
  press(view, { name: 'enter' });
  // github.repo: leave empty to keep auto-detection.
  press(view, { name: 'enter' });
  // github.token
  type(view, 'ghp-abc');
  press(view, { name: 'enter' });
  // bareAgentMode (claude was kept), review, autoMergeOnGreen: accept each as it stands.
  press(view, { name: 'enter' }, { name: 'enter' }, { name: 'enter' });

  assert.ok(textOf(view).some((line) => line.includes('Ready to write')), 'the wizard ends on a summary, not a silent write');
  assert.equal(io.saves, 0, 'nothing is written before the summary is confirmed');

  press(view, { name: 'enter' });
  assert.equal(io.saves, 1);
  assert.equal(getAtPath(io.settings, 'forge'), 'github');
  assert.equal(getAtPath(io.settings, 'github.token'), 'ghp-abc');
  assert.equal(getAtPath(io.settings, 'bareAgentMode'), true);
});

test('accepting every wizard step preserves the settings already in force rather than flipping them to the first choice', () => {
  // `review` is deliberately off by default; walking the guide without changing
  // anything must not turn it on just because "on" is the top choice on screen.
  const io = fakeSettingsIo();
  const view = new SetupView(io);
  press(view, { name: 'enter' });
  for (let i = 0; i < 8; i++) press(view, { name: 'enter' });
  assert.ok(textOf(view).some((line) => line.includes('Ready to write')));
  press(view, { name: 'enter' });
  assert.equal(getAtPath(io.settings, 'review'), false);
  assert.equal(getAtPath(io.settings, 'forge'), 'gitlab');
  assert.equal(getAtPath(io.settings, 'agent'), 'claude');
});

test('the wizard summary masks the token it is about to write', () => {
  const io = fakeSettingsIo();
  const view = new SetupView(io);
  // intro -> forge (keep gitlab) -> agent (keep claude) -> gitlab.host (skip) -> gitlab.token
  press(view, { name: 'enter' }, { name: 'enter' }, { name: 'enter' }, { name: 'enter' });
  type(view, 'glpat-secret');
  // token -> repoBase -> bareAgentMode -> review -> autoMergeOnGreen -> summary
  press(view, { name: 'enter' }, { name: 'enter' }, { name: 'enter' }, { name: 'enter' }, { name: 'enter' });
  const shown = textOf(view).join('\n');
  assert.ok(shown.includes('Ready to write'));
  assert.ok(!shown.includes('glpat-secret'));
});

test('leaving the wizard before the summary writes nothing', () => {
  const io = fakeSettingsIo();
  const view = new SetupView(io);
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'pop' });
  assert.equal(io.saves, 0);
});

function session(branch: string, overrides: Partial<RunSession['state']> = {}): RunSession {
  return {
    branch,
    state: {
      branch,
      targetBranch: 'main',
      worktreePath: `/tmp/${branch}`,
      ciFixAttempt: 0,
      conflictAttempt: 0,
      phase: 'watch',
      updatedAt: '2026-01-02T03:04:05.000Z',
      ...overrides,
    },
  };
}

function fakeSessionsIo(sessions: RunSession[]): SessionsIo & { resumed: string[]; reviewed: string[]; copied: string[] } {
  const io = {
    resumed: [] as string[],
    reviewed: [] as string[],
    copied: [] as string[],
    list: () => sessions,
    resume: async (branch: string) => {
      io.resumed.push(branch);
    },
    review: async (branch: string) => {
      io.reviewed.push(branch);
    },
    mrUrl: (state: RunSession['state']) => state.mrUrl,
    copy: (text: string) => {
      io.copied.push(text);
    },
  };
  return io;
}

const MR = { mrIid: 12, mrUrl: 'https://gitlab.example/group/app/-/merge_requests/12' };

test('the sessions browser says so plainly when the repo has no runs', () => {
  const view = new SessionsView(fakeSessionsIo([]));
  assert.ok(textOf(view).some((line) => line.includes('No runs recorded')));
});

test('the sessions browser lists each run with its phase', () => {
  const view = new SessionsView(fakeSessionsIo([session('feat/a'), session('feat/b', { phase: 'done', mrIid: 12 })]));
  const shown = textOf(view).join('\n');
  assert.ok(shown.includes('feat/a'));
  assert.ok(shown.includes('feat/b'));
  assert.ok(shown.includes('#12'));
});

const NOOP_CTX = { redraw: () => {} };

test('r resumes the highlighted run through the in-TUI dashboard, and only once the run action is applied', async () => {
  const io = fakeSessionsIo([session('feat/a'), session('feat/b')]);
  const view = new SessionsView(io);
  press(view, { name: 'down' });
  const action = press(view, { name: 'char', value: 'r' });
  assert.equal(action.type, 'run');
  assert.equal(io.resumed.length, 0, 'the job must not start until the app applies the run action');
  if (action.type === 'run') await action.run(NOOP_CTX);
  assert.deepEqual(io.resumed, ['feat/b']);
});

test('v reviews the highlighted run', async () => {
  const io = fakeSessionsIo([session('feat/a')]);
  const view = new SessionsView(io);
  const action = press(view, { name: 'char', value: 'v' });
  assert.equal(action.type, 'run');
  if (action.type === 'run') await action.run(NOOP_CTX);
  assert.deepEqual(io.reviewed, ['feat/a']);
});

test('enter opens the run timeline, and a run with no history says why', () => {
  const io = fakeSessionsIo([session('feat/a')]);
  const view = new SessionsView(io);
  const action = press(view, { name: 'enter' });
  assert.equal(action.type, 'push');
  if (action.type !== 'push') return;
  assert.ok(textOf(action.view).some((line) => line.includes('no step history')));
});

test('the timeline shows history entries and scrolls', () => {
  const history = Array.from({ length: 60 }, (_, i) => ({
    at: '2026-01-02T03:04:05.000Z',
    phase: 'watch' as const,
    level: 'info' as const,
    message: `event ${i}`,
  }));
  const view = new SessionDetailView(session('feat/a', { history }), fakeSessionsIo([]));
  const small = { columns: 90, rows: 12 };
  const first = view.render(small).body.map(plainText).join('\n');
  assert.ok(first.includes('event 0'));
  assert.ok(!first.includes('event 40'));
  for (let i = 0; i < 5; i++) press(view, { name: 'pagedown' });
  const scrolled = view.render(small).body.map(plainText).join('\n');
  assert.ok(scrolled.includes('event 50'));
  assert.ok(!scrolled.includes('event 0\n'), 'the top of the timeline has scrolled away');
});

test('the timeline shows the mr/pr url, so the run ends somewhere the user can go', () => {
  const view = new SessionDetailView(session('feat/a', MR), fakeSessionsIo([]));
  assert.ok(textOf(view).join('\n').includes(MR.mrUrl));
});

test('a run recorded before mrUrl existed shows its iid and says no url was recorded', () => {
  const view = new SessionDetailView(session('feat/a', { mrIid: 9 }), fakeSessionsIo([]));
  const shown = textOf(view).join('\n');
  assert.match(shown, /#9 \(no url recorded\)/);
});

test('a run with no mr/pr at all has no mr/pr row', () => {
  const view = new SessionDetailView(session('feat/a'), fakeSessionsIo([]));
  assert.ok(!textOf(view).some((line) => line.startsWith('mr/pr')));
});

test('y copies the focused run’s mr/pr url from the list and says so', () => {
  const io = fakeSessionsIo([session('feat/a'), session('feat/b', MR)]);
  const view = new SessionsView(io);
  press(view, { name: 'down' });
  press(view, { name: 'char', value: 'y' });
  assert.deepEqual(io.copied, [MR.mrUrl]);
  assert.ok(view.render(SIZE).hints.includes(MR.mrUrl), 'the url is shown as well, since a terminal may ignore OSC 52');
});

test('y copies from the timeline too', () => {
  const io = fakeSessionsIo([]);
  const view = new SessionDetailView(session('feat/a', MR), io);
  press(view, { name: 'char', value: 'y' });
  assert.deepEqual(io.copied, [MR.mrUrl]);
});

test('y on a run with no mr/pr copies nothing and explains why', () => {
  const io = fakeSessionsIo([session('feat/a', { phase: 'checks' })]);
  const view = new SessionsView(io);
  press(view, { name: 'char', value: 'y' });
  assert.deepEqual(io.copied, []);
  assert.match(view.render(SIZE).hints, /no mr\/pr yet/);
});

test('the copy message clears on the next keypress, so it never lingers as the hint', () => {
  const io = fakeSessionsIo([session('feat/a', MR)]);
  const view = new SessionsView(io);
  press(view, { name: 'char', value: 'y' });
  press(view, { name: 'down' });
  assert.ok(!view.render(SIZE).hints.includes('copied'));
});

test('the run launcher passes the typed ticket and target through, and omits empty ones', async () => {
  const started: Array<{ ticket?: string; target?: string }> = [];
  const io: RunIo = {
    start: async (options) => {
      started.push(options);
    },
  };
  const view = new RunView(io);
  type(view, 'PROJ-123');
  press(view, { name: 'down' });
  type(view, 'release/2.0');
  press(view, { name: 'down' });
  const action = press(view, { name: 'enter' });
  assert.equal(action.type, 'run');
  if (action.type === 'run') await action.run(NOOP_CTX);
  assert.deepEqual(started, [{ ticket: 'PROJ-123', target: 'release/2.0' }]);
});

test('the run launcher sends undefined, not an empty string, for flags left blank', async () => {
  const started: Array<{ ticket?: string; target?: string }> = [];
  const view = new RunView({
    start: async (options) => {
      started.push(options);
    },
  });
  press(view, { name: 'down' }, { name: 'down' }, { name: 'enter' });
  const action = view.onKey({ name: 'enter' }) as Action;
  if (action.type === 'run') await action.run(NOOP_CTX);
  assert.deepEqual(started[0], { ticket: undefined, target: undefined });
});

test('typing q into the run launcher edits the field instead of quitting', () => {
  const view = new RunView({ start: async () => {} });
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'none' });
  assert.ok(textOf(view).join('\n').includes('q'));
});

test('the menu moves its cursor and runs the selected item', () => {
  const picked: string[] = [];
  const view = new MenuView('home', [
    {
      label: 'First',
      onSelect: () => {
        picked.push('first');
        return { type: 'none' };
      },
    },
    {
      label: 'Second',
      onSelect: () => {
        picked.push('second');
        return { type: 'quit' };
      },
    },
  ]);
  press(view, { name: 'down' });
  assert.deepEqual(press(view, { name: 'enter' }), { type: 'quit' });
  assert.deepEqual(picked, ['second']);
});

test('pressing q on a menu pops the view instead of doing nothing', () => {
  const view = new MenuView('home', [{ label: 'First', onSelect: () => ({ type: 'none' }) }]);
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'pop' });
  assert.deepEqual(press(view, { name: 'escape' }), { type: 'pop' });
});

test('the menu marks exactly one row as selected', () => {
  const view = new MenuView('home', [
    { label: 'First', onSelect: () => ({ type: 'none' }) },
    { label: 'Second', onSelect: () => ({ type: 'none' }) },
  ]);
  const marked = textOf(view).filter((line) => line.startsWith(SELECTED));
  assert.equal(marked.length, 1);
  assert.ok(marked[0].includes('First'));
});

/** Two described items — enough to tell "only the focused description" from "all of them". */
function describedMenu(): MenuView {
  return new MenuView('home', [
    { label: 'Run workflow', description: 'Capture the diff', onSelect: () => ({ type: 'none' }) },
    { label: 'Sessions', description: 'Browse past runs', onSelect: () => ({ type: 'none' }) },
  ]);
}

test('only the focused menu item shows its description, so the choices stay on one screen', () => {
  const view = describedMenu();
  const before = textOf(view).join('\n');
  assert.ok(before.includes('Capture the diff'));
  assert.ok(!before.includes('Browse past runs'));
  press(view, { name: 'char', value: 'j' });
  const after = textOf(view).join('\n');
  assert.ok(after.includes('Browse past runs'));
  assert.ok(!after.includes('Capture the diff'));
});

test('j and k move the menu cursor exactly like the arrow keys', () => {
  const arrows = describedMenu();
  const vim = describedMenu();
  press(arrows, { name: 'down' });
  press(vim, { name: 'char', value: 'j' });
  assert.deepEqual(textOf(vim), textOf(arrows));
  press(arrows, { name: 'up' });
  press(vim, { name: 'char', value: 'k' });
  assert.deepEqual(textOf(vim), textOf(arrows));
});

test('/ filters the menu to matching labels and selects the first survivor', () => {
  const view = describedMenu();
  press(view, { name: 'char', value: '/' });
  type(view, 'sess');
  const rows = textOf(view).join('\n');
  assert.ok(rows.includes('Sessions'));
  assert.ok(!rows.includes('Run workflow'));
  // ⏎ closes the input; the query stays applied and ⏎ again picks the match.
  press(view, { name: 'enter' });
  assert.ok(view.render(SIZE).hints.includes('j/k move'));
});

test('a filter that matches nothing says so rather than rendering an empty screen', () => {
  const view = describedMenu();
  press(view, { name: 'char', value: '/' });
  type(view, 'zzz');
  assert.ok(textOf(view).join('\n').includes('no match for "zzz"'));
  // ⏎ on nothing must not throw or navigate.
  assert.deepEqual(press(view, { name: 'enter' }), { type: 'none' });
});

test('q clears a standing filter before it leaves the menu, so a subset is never a dead end', () => {
  const view = describedMenu();
  press(view, { name: 'char', value: '/' });
  type(view, 'sess');
  press(view, { name: 'enter' });
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'none' });
  assert.ok(textOf(view).join('\n').includes('Run workflow'));
  // Filter gone, so the next q really does leave.
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'pop' });
});

test('while typing a filter, q and j are query characters rather than commands', () => {
  const view = describedMenu();
  press(view, { name: 'char', value: '/' });
  assert.deepEqual(press(view, { name: 'char', value: 'q' }), { type: 'none' });
  press(view, { name: 'char', value: 'j' });
  assert.ok(textOf(view).join('\n').includes('/qj'));
});

test('/ filters the sessions list by branch and reports how many of the runs survived', () => {
  const io = fakeSessionsIo([session('feat/alpha'), session('fix/beta'), session('feat/gamma')]);
  const view = new SessionsView(io);
  press(view, { name: 'char', value: '/' });
  type(view, 'feat');
  press(view, { name: 'enter' });
  const rows = textOf(view).join('\n');
  assert.ok(rows.includes('feat/alpha'));
  assert.ok(rows.includes('feat/gamma'));
  assert.ok(!rows.includes('fix/beta'));
  assert.ok(rows.includes('2 of 3'));
});

test('the sessions actions operate on the filtered cursor, not the unfiltered index underneath it', async () => {
  const io = fakeSessionsIo([session('feat/alpha'), session('fix/beta'), session('feat/gamma')]);
  const view = new SessionsView(io);
  press(view, { name: 'char', value: '/' });
  type(view, 'feat');
  press(view, { name: 'enter' });
  // Cursor is on the first match; j moves to the second match, not to fix/beta.
  press(view, { name: 'char', value: 'j' });
  const action = press(view, { name: 'char', value: 'r' });
  assert.equal(action.type, 'run');
  if (action.type === 'run') await action.run(NOOP_CTX);
  assert.deepEqual(io.resumed, ['feat/gamma']);
});

test('the sessions list shows ages rather than absolute timestamps, keeping the branch column intact at 80 columns', () => {
  const io = fakeSessionsIo([session('feat/a', { updatedAt: new Date(Date.now() - 4 * 60_000).toISOString() })]);
  const view = new SessionsView(io);
  const rows = view.render({ columns: 76, rows: 20 }).body.map((line: Line) => plainText(line));
  const row = rows.find((line) => line.includes('feat/a'));
  assert.ok(row, 'branch row missing');
  assert.ok(row.includes('4m ago'), row);
  assert.ok(!row.includes('2026'), 'an absolute date leaked into the list');
});

test('the sessions row keeps every column inside a narrow terminal instead of clipping the clock off', () => {
  const io = fakeSessionsIo([session('feature/a-really-quite-long-branch-name-here', { mrIid: 42 })]);
  const view = new SessionsView(io);
  for (const columns of [56, 76, 120]) {
    const rows = view.render({ columns, rows: 20 }).body.map((line: Line) => plainText(line));
    const row = rows.find((line) => line.startsWith(SELECTED));
    assert.ok(row, `no selected row at ${columns} columns`);
    assert.ok(row.length <= columns, `row overflowed at ${columns} columns`);
    assert.ok(row.includes('#42'), `mr column lost at ${columns} columns`);
    assert.ok(row.includes('ago') || row.includes('unknown'), `updated column lost at ${columns} columns`);
  }
});

test('every screen\'s hint strip fits an 80-column frame, which is where it lives', () => {
  const size = { columns: 80, rows: 24 };
  const inner = { columns: size.columns - 4, rows: size.rows - 2 };
  const screens: Array<[string, View]> = [
    ['sessions', new SessionsView(fakeSessionsIo([session('feat/a')]))],
    ['settings', new SettingsView(fakeSettingsIo())],
    ['run', new RunView({ start: async () => {} })],
    ['menu', describedMenu()],
    ['setup', new SetupView(fakeSettingsIo())],
  ];
  for (const [name, view] of screens) {
    const strip = view.render(inner).hints;
    // Two corners plus a space either side of the strip; overflowing costs the
    // whole border row to truncation.
    assert.ok(strip.length + 4 <= size.columns, `${name} hint strip is ${strip.length} chars: ${strip}`);
  }
});

test('vim keys walk the settings editor over its group headings, the same as the arrows do', () => {
  const arrows = new SettingsView(fakeSettingsIo());
  const vim = new SettingsView(fakeSettingsIo());
  press(arrows, { name: 'down' }, { name: 'down' });
  press(vim, { name: 'char', value: 'j' }, { name: 'char', value: 'j' });
  assert.deepEqual(textOf(vim), textOf(arrows));
  // A heading is never left under the cursor.
  const selected = textOf(vim).filter((line) => line.startsWith(SELECTED));
  assert.equal(selected.length, 1);
  assert.ok(!selected[0].includes('──'));
});

test('G jumps the settings cursor to the last field and g back to the first', () => {
  const view = new SettingsView(fakeSettingsIo());
  const first = textOf(view).filter((line) => line.startsWith(SELECTED))[0];
  press(view, { name: 'char', value: 'G' });
  const last = textOf(view).filter((line) => line.startsWith(SELECTED))[0];
  assert.notEqual(last, first);
  assert.ok(!last.includes('──'), 'G landed on a group heading');
  press(view, { name: 'char', value: 'g' });
  assert.equal(textOf(view).filter((line) => line.startsWith(SELECTED))[0], first);
});

test('d still resets a settings field, so the page keys did not steal it', () => {
  const io = fakeSettingsIo({ agent: 'copilot' });
  const view = new SettingsView(io);
  focusField(view, 'agent');
  press(view, { name: 'char', value: 'd' });
  assert.equal(getAtPath(io.read(), 'agent'), undefined);
});
