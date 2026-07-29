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
import { clampIndex, moveIndex, viewportWindow } from '../list.js';
import { formatTokens } from '../../format.js';
import { runInDashboard } from './runDashboard.js';
import { NONE, isBackKey, type Action, type RenderedView, type View } from '../view.js';
import type { RunSession } from '../../../state/runState.js';
import type { RunPhase } from '../../../types.js';
import type { MochaRole } from '../../theme.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';

const PHASE_ROLE: Record<RunPhase, MochaRole> = {
  diff: 'overlay1',
  intent: 'overlay1',
  checks: 'sky',
  mr: 'sky',
  watch: 'yellow',
  done: 'green',
  escalated: 'red',
};

function timestamp(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : 'unknown';
}

const BRANCH_COLUMN = 34;

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
        seg(`${timestamp(entry.at)} `, { role: 'overlay1' }),
        seg(`[${entry.phase}] `, { role: 'overlay1' }),
        seg(entry.message, { role: entry.level === 'error' ? 'red' : undefined }),
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
      hints: this.flash ?? '↑↓ scroll · y copy mr/pr url · q back',
    };
  }

  onKey(key: Key): Action {
    if (isBackKey(key)) return { type: 'pop' };
    this.flash = undefined;
    if (key.name === 'char' && key.value === 'y') this.flash = copyMrUrl(this.io, this.session);
    else if (key.name === 'up') this.offset = Math.max(0, this.offset - 1);
    else if (key.name === 'down') this.offset += 1;
    else if (key.name === 'pageup') this.offset = Math.max(0, this.offset - 10);
    else if (key.name === 'pagedown') this.offset += 10;
    return NONE;
  }
}

export class SessionsView implements View {
  private sessions: RunSession[];
  private index = 0;
  private windowStart = 0;
  private flash: string | undefined;

  constructor(private readonly io: SessionsIo) {
    this.sessions = io.list();
  }

  private focused(): RunSession | undefined {
    return this.sessions[clampIndex(this.index, this.sessions.length)];
  }

  private row(session: RunSession, selected: boolean): Line {
    const { state } = session;
    const branch = state.branch.length > BRANCH_COLUMN ? `${state.branch.slice(0, BRANCH_COLUMN - 1)}…` : state.branch.padEnd(BRANCH_COLUMN);
    return [
      seg(selected ? '❯ ' : '  ', { role: 'sky', bold: true }),
      seg(`${branch} `, { bold: selected }),
      seg(state.phase.padEnd(10), { role: PHASE_ROLE[state.phase] }),
      seg(`${state.mrIid !== undefined ? `#${state.mrIid}` : '-'}`.padEnd(8), { role: 'overlay1' }),
      seg(timestamp(state.updatedAt), { role: 'overlay1' }),
    ];
  }

  render(inner: Size): RenderedView {
    if (this.sessions.length === 0) {
      return {
        title: 'sessions',
        body: [[seg('No runs recorded in this repo yet (.pipeline-worker/state/ is empty).', { role: 'overlay1' })]],
        hints: 'q back',
      };
    }
    const header: Line = [
      seg('  '),
      seg(`${'BRANCH'.padEnd(BRANCH_COLUMN)} ${'PHASE'.padEnd(10)}${'MR/PR'.padEnd(8)}UPDATED`, { bold: true, role: 'overlay1' }),
    ];
    const listRows = Math.max(1, inner.rows - 1);
    const { start, end } = viewportWindow(this.index, this.sessions.length, listRows, this.windowStart);
    this.windowStart = start;
    const body: Line[] = [header];
    for (let i = start; i < end; i++) body.push(this.row(this.sessions[i], i === this.index));
    return { title: 'sessions', body, hints: this.flash ?? '↑↓ move · ⏎ timeline · r resume · v review · y copy url · q back' };
  }

  // fallow-ignore-next-line complexity
  onKey(key: Key): Action {
    if (isBackKey(key)) return { type: 'pop' };
    const focused = this.focused();
    this.flash = undefined;
    if (key.name === 'up') this.index = moveIndex(this.index, -1, this.sessions.length);
    else if (key.name === 'down') this.index = moveIndex(this.index, 1, this.sessions.length);
    else if (key.name === 'enter' && focused) return { type: 'push', view: new SessionDetailView(focused, this.io) };
    else if (key.name === 'char' && key.value === 'y') this.flash = copyMrUrl(this.io, focused);
    else if (key.name === 'char' && key.value === 'r' && focused) {
      const branch = focused.state.branch;
      return runInDashboard(`resume ${branch}`, () => this.io.resume(branch));
    } else if (key.name === 'char' && key.value === 'v' && focused) {
      const branch = focused.state.branch;
      return runInDashboard(`review ${branch}`, () => this.io.review(branch));
    }
    return NONE;
  }
}
