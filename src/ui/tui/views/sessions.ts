/**
 * The sessions browser: `pipeline-worker sessions` with a cursor on it. The
 * list view shows every persisted run in this repo, and drilling in shows that
 * run's full timeline.
 *
 * The two actions that matter live here rather than in a separate menu,
 * because "this run died, pick it back up" is the whole reason to look at this
 * screen: r resumes the highlighted run and v reviews its MR/PR, both by
 * opening the same in-TUI run dashboard the run launcher uses.
 */

import { seg, type Line } from '../line.js';
import { selectionRow } from '../chrome.js';
import {
  applyFilterKey,
  applyNav,
  clampIndex,
  matchesFilter,
  navIntent,
  NO_FILTER,
  viewportWindow,
  type FilterState,
} from '../list.js';
import { formatRelative, formatTokens } from '../../format.js';
import { runInDashboard } from './runDashboard.js';
import { HINT, NONE, hints, isBackKey, type Action, type RenderedView, type View } from '../view.js';
import type { RunSession } from '../../../state/runState.js';
import type { RunPhase } from '../../../types.js';
import type { MochaRole } from '../../theme.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';

const PHASE_ROLE: Record<RunPhase, MochaRole> = {
  diff: 'overlay1',
  apply: 'overlay1',
  intent: 'overlay1',
  commit: 'sky',
  checks: 'sky',
  mr: 'sky',
  watch: 'yellow',
  done: 'green',
  escalated: 'red',
};

function timestamp(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : 'unknown';
}

/** Fixed right-hand columns; 'escalated' is the longest phase and '52w ago' the longest age. */
const PHASE_WIDTH = 10;
const MR_WIDTH = 7;
const UPDATED_WIDTH = 7;
/** Below this the branch is unreadable anyway, so the row is allowed to overflow and be truncated by the frame. */
const MIN_BRANCH_WIDTH = 12;

/** The branch column takes whatever the fixed columns leave, rather than a constant that clips the clock off an 80-column terminal. */
function branchWidth(columns: number): number {
  // Selection bars (2), the row's leading space (1), the gap after the branch
  // (1), then the three fixed right-hand columns.
  const fixed = 2 + 1 + 1 + PHASE_WIDTH + MR_WIDTH + UPDATED_WIDTH;
  return Math.max(MIN_BRANCH_WIDTH, columns - fixed);
}

function fitColumn(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/** What the browser needs from the outside world — injected so tests supply sessions without a repo on disk. */
export interface SessionsIo {
  list(): RunSession[];
  resume(branch: string): Promise<void>;
  review(branch: string): Promise<void>;
  /** Web URL of this run's MR/PR, rebuilt from settings for state files that predate RunState.mrUrl (see ui/mrUrl.ts). */
  mrUrl(state: RunSession['state']): string | undefined;
  /** Puts text on the terminal's clipboard. Silent when the terminal refuses OSC 52, so the URL is always shown too. */
  copy(text: string): void;
}

/**
 * `y` on either screen: the MR/PR is what a run produces, and an escalated run
 * is exactly the case where the user has to go look at it, so the URL is one
 * key away rather than something to retype from the timeline. The message is
 * returned instead of printed — a view never writes to the terminal itself.
 */
function copyMrUrl(io: SessionsIo, session: RunSession | undefined): string {
  if (!session) return 'no run selected';
  const url = io.mrUrl(session.state);
  if (!url) return 'this run has no mr/pr yet';
  io.copy(url);
  return `copied ${url}`;
}

/** One run's full timeline, scrollable — the TUI form of `sessions --branch <name>`. */
export class SessionDetailView implements View {
  private offset = 0;
  private flash: string | undefined;

  constructor(
    private readonly session: RunSession,
    private readonly io: SessionsIo,
  ) {}

  private lines(): Line[] {
    const { state } = this.session;
    const rows: Line[] = [
      [seg('target   ', { role: 'overlay1' }), seg(state.targetBranch)],
      [seg('worktree ', { role: 'overlay1' }), seg(state.worktreePath)],
      [
        seg('phase    ', { role: 'overlay1' }),
        seg(state.phase, { role: PHASE_ROLE[state.phase] }),
        seg(`  ci-fix ${state.ciFixAttempt}  conflict ${state.conflictAttempt}`, { role: 'overlay1' }),
        seg(state.mrIid !== undefined ? `  mr/pr #${state.mrIid}` : '', { role: 'overlay1' }),
        seg(state.totalTokens !== undefined ? `  ${formatTokens(state.totalTokens)}` : '', { role: 'overlay1' }),
      ],
      ...(state.mrIid !== undefined
        ? [[seg('mr/pr    ', { role: 'overlay1' }), seg(this.io.mrUrl(state) ?? `#${state.mrIid} (no url recorded)`)] satisfies Line]
        : []),
      [seg('started  ', { role: 'overlay1' }), seg(timestamp(state.startedAt))],
      [seg('updated  ', { role: 'overlay1' }), seg(timestamp(state.updatedAt))],
      [],
    ];
    const history = state.history ?? [];
    if (history.length === 0) {
      rows.push([seg('(no step history — this run predates session history)', { role: 'overlay1' })]);
      return rows;
    }
    rows.push([seg('Timeline', { bold: true })]);
    for (const entry of history) {
      rows.push([
        seg(entry.level === 'error' ? ' ✗ ' : ' · ', { role: entry.level === 'error' ? 'red' : 'overlay1' }),
        // Relative, not absolute: a timeline is read for the gaps between its
        // steps, and 40 rows of identical date prefixes bury the messages.
        seg(`${formatRelative(entry.at).padEnd(UPDATED_WIDTH)} `, { role: 'overlay1' }),
        seg(`[${entry.phase}] `, { role: 'overlay1' }),
        seg(entry.message, { role: entry.level === 'error' ? 'red' : 'subtext0' }),
        seg(entry.tokens !== undefined ? ` · ${formatTokens(entry.tokens)}` : '', { role: 'overlay1' }),
      ]);
    }
    return rows;
  }

  render(inner: Size): RenderedView {
    const all = this.lines();
    this.offset = Math.min(this.offset, Math.max(0, all.length - inner.rows));
    return {
      title: `session · ${this.session.state.branch}`,
      body: all.slice(this.offset, this.offset + inner.rows),
      hints: this.flash ?? hints(HINT.scroll, 'y copy mr/pr url', HINT.back),
    };
  }

  onKey(key: Key): Action {
    if (isBackKey(key)) return { type: 'pop' };
    this.flash = undefined;
    if (key.name === 'char' && key.value === 'y') {
      this.flash = copyMrUrl(this.io, this.session);
      return NONE;
    }
    const nav = navIntent(key);
    // A scroll offset is a cursor over rows, but it must not wrap — 'G' at the
    // end of a long timeline is asking for the bottom, not the top.
    if (nav) {
      if (nav.kind === 'first') this.offset = 0;
      else if (nav.kind === 'last') this.offset = Number.MAX_SAFE_INTEGER;
      else this.offset = Math.max(0, this.offset + nav.delta);
    }
    return NONE;
  }
}

export class SessionsView implements View {
  private sessions: RunSession[];
  private index = 0;
  private windowStart = 0;
  private flash: string | undefined;
  private filter: FilterState = NO_FILTER;

  constructor(private readonly io: SessionsIo) {
    this.sessions = io.list();
  }

  /** The rows the filter lets through — what the cursor indexes and what the actions operate on. */
  private visible(): RunSession[] {
    if (this.filter.query === '') return this.sessions;
    return this.sessions.filter((session) => matchesFilter(session.state.branch, this.filter.query));
  }

  private focused(): RunSession | undefined {
    const visible = this.visible();
    return visible[clampIndex(this.index, visible.length)];
  }

  private row(session: RunSession, selected: boolean, columns: number): Line {
    const { state } = session;
    const content: Line = [
      seg(' '),
      seg(`${fitColumn(state.branch, branchWidth(columns))} `),
      seg(state.phase.padEnd(PHASE_WIDTH), { role: PHASE_ROLE[state.phase] }),
      seg(`${state.mrIid !== undefined ? `#${state.mrIid}` : '-'}`.padEnd(MR_WIDTH), { role: 'overlay1' }),
      seg(formatRelative(state.updatedAt), { role: 'overlay1' }),
    ];
    return selectionRow(content, columns, selected);
  }

  private headerRow(columns: number): Line {
    const text = ` ${'BRANCH'.padEnd(branchWidth(columns))} ${'PHASE'.padEnd(PHASE_WIDTH)}${'MR/PR'.padEnd(MR_WIDTH)}UPDATED`;
    return [seg(' '), seg(text, { role: 'overlay1' })];
  }

  /** The '/' input line, or the standing filter once ⏎ has closed the input. */
  private filterRow(): Line | undefined {
    if (this.filter.typing) return [seg('/', { role: 'mauve', bold: true }), seg(this.filter.query), seg(' ', { invert: true })];
    if (this.filter.query === '') return undefined;
    return [seg('/', { role: 'mauve' }), seg(this.filter.query, { role: 'mauve' }), seg(`  ${this.visible().length} of ${this.sessions.length}`, { role: 'overlay1' })];
  }

  render(inner: Size): RenderedView {
    if (this.sessions.length === 0) {
      return {
        title: 'sessions',
        body: [[seg('No runs recorded in this repo yet (.pipeline-worker/state/ is empty).', { role: 'overlay1' })]],
        hints: HINT.back,
      };
    }
    const visible = this.visible();
    this.index = clampIndex(this.index, visible.length);
    const filterRow = this.filterRow();
    const listRows = Math.max(1, inner.rows - 1 - (filterRow ? 2 : 0));
    const { start, end } = viewportWindow(this.index, visible.length, listRows, this.windowStart);
    this.windowStart = start;

    const body: Line[] = [this.headerRow(inner.columns)];
    if (visible.length === 0) body.push([seg(` no branch matches "${this.filter.query}"`, { role: 'overlay1' })]);
    for (let i = start; i < end; i++) body.push(this.row(visible[i], i === this.index, inner.columns));
    if (filterRow) body.push([], filterRow);

    return { title: 'sessions', body, hints: this.hints() };
  }

  private hints(): string {
    if (this.filter.typing) return hints(HINT.filtering, HINT.clear);
    // Kept short enough to survive an 80-column frame: the strip lives in the
    // bottom border, and a strip that overflows costs the whole border row.
    return this.flash ?? hints(HINT.move, '⏎ open', 'r resume', 'v review', 'y url', HINT.filter, HINT.back);
  }

  // fallow-ignore-next-line complexity
  onKey(key: Key): Action {
    const filtered = applyFilterKey(this.filter, key);
    if (filtered) {
      this.filter = filtered;
      this.index = 0;
      return NONE;
    }
    // While typing, r/v/y/q are query characters, not commands.
    if (this.filter.typing) return NONE;
    // Cleared before anything else handles the key: a copy message has been
    // read by the time the next keystroke arrives, and leaving it pinned would
    // hide the real hints.
    this.flash = undefined;
    const nav = navIntent(key);
    if (nav) {
      this.index = applyNav(nav, this.index, this.visible().length);
      return NONE;
    }
    const focused = this.focused();
    if (key.name === 'enter' && focused) return { type: 'push', view: new SessionDetailView(focused, this.io) };
    if (key.name === 'char' && key.value === 'y') this.flash = copyMrUrl(this.io, focused);
    else if (key.name === 'char' && key.value === 'r' && focused) {
      const branch = focused.state.branch;
      return runInDashboard(`resume ${branch}`, () => this.io.resume(branch));
    } else if (key.name === 'char' && key.value === 'v' && focused) {
      const branch = focused.state.branch;
      return runInDashboard(`review ${branch}`, () => this.io.review(branch));
    } else if (isBackKey(key)) {
      if (this.filter.query === '') return { type: 'pop' };
      this.filter = NO_FILTER;
    }
    return NONE;
  }
}
