/**
 * Cursor and scrolling arithmetic for every selectable list in the TUI (home
 * menu, settings fields, session list, wizard choices). Pure functions rather
 * than a widget class, so each rule — wrapping at the ends, keeping the cursor
 * inside the viewport, clamping a stale index after the list shrinks — is
 * unit-testable on its own.
 *
 * Also the one place list *input* is decoded (navIntent, the '/' filter), so
 * every list-shaped screen answers to the same keys instead of each view
 * hand-binding its own arrows.
 */

import type { Key } from './keys.js';

/**
 * Moves a cursor by `delta`, wrapping at both ends: pressing ↑ on the first
 * item lands on the last. Wrapping matters most on the short menus, where
 * reaching the last item ("Quit") should not mean holding ↓.
 */
export function moveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** Clamps a possibly-stale index into a list that changed size underneath it. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/**
 * The slice of a list to paint so that `index` stays visible, scrolling only
 * when the cursor would leave the window. Returns a half-open [start, end)
 * range covering at most `viewport` items.
 */
export function viewportWindow(index: number, length: number, viewport: number, previousStart = 0): { start: number; end: number } {
  if (viewport <= 0 || length <= 0) return { start: 0, end: 0 };
  const maxStart = Math.max(0, length - viewport);
  let start = Math.min(previousStart, maxStart);
  if (index < start) start = index;
  else if (index >= start + viewport) start = index - viewport + 1;
  return { start, end: Math.min(length, start + viewport) };
}

/**
 * Advances a cursor over a list where only some entries are selectable —
 * the settings view interleaves group headings with fields, and the headings
 * must be skipped over rather than landed on. Returns the original index when
 * nothing is selectable, so a caller can never spin forever.
 */
export function moveToSelectable(index: number, delta: number, length: number, selectable: (i: number) => boolean): number {
  if (length <= 0) return 0;
  let next = index;
  for (let step = 0; step < length; step++) {
    next = moveIndex(next, delta, length);
    if (selectable(next)) return next;
  }
  return index;
}

/** The first selectable index (or 0 when there is none) — where a view's cursor starts. */
export function firstSelectable(length: number, selectable: (i: number) => boolean): number {
  for (let i = 0; i < length; i++) {
    if (selectable(i)) return i;
  }
  return 0;
}

/** How far a navigation key moves the cursor: by a step, by a page, or to an end. */
export type NavIntent = { kind: 'move'; delta: number } | { kind: 'first' } | { kind: 'last' };

/** Rows a page key jumps when the caller has no better idea of its viewport height. */
export const DEFAULT_PAGE = 10;

/**
 * Decodes a keypress into a cursor movement, accepting both the arrow-key set
 * and the vim set every developer already has in their fingers. Returns
 * undefined for anything that is not navigation, so a view can fall through to
 * its own bindings.
 *
 * ctrl-d/ctrl-u are the page keys rather than plain d/u because settings binds
 * `d` to "reset to default" — the modifier keeps the two apart.
 */
// fallow-ignore-next-line complexity
export function navIntent(key: Key, page: number = DEFAULT_PAGE): NavIntent | undefined {
  if (key.name === 'up') return { kind: 'move', delta: -1 };
  if (key.name === 'down') return { kind: 'move', delta: 1 };
  if (key.name === 'pageup') return { kind: 'move', delta: -page };
  if (key.name === 'pagedown') return { kind: 'move', delta: page };
  if (key.name === 'home') return { kind: 'first' };
  if (key.name === 'end') return { kind: 'last' };
  if (key.name === 'ctrl' && key.value === 'u') return { kind: 'move', delta: -page };
  if (key.name === 'ctrl' && key.value === 'd') return { kind: 'move', delta: page };
  if (key.name !== 'char') return undefined;
  if (key.value === 'k') return { kind: 'move', delta: -1 };
  if (key.value === 'j') return { kind: 'move', delta: 1 };
  if (key.value === 'g') return { kind: 'first' };
  if (key.value === 'G') return { kind: 'last' };
  return undefined;
}

/** Folds a NavIntent into a wrapping cursor over a list of `length` items. */
export function applyNav(intent: NavIntent, index: number, length: number): number {
  if (length <= 0) return 0;
  if (intent.kind === 'first') return 0;
  if (intent.kind === 'last') return length - 1;
  // Page moves clamp instead of wrapping: ctrl-d at the bottom should stay put,
  // not teleport back to the top the way a single j does.
  if (Math.abs(intent.delta) > 1) return clampIndex(index + intent.delta, length);
  return moveIndex(index, intent.delta, length);
}

/**
 * The '/' filter shared by the home menu and the sessions browser. `typing` is
 * whether keystrokes are still going into the query; the query itself stays
 * applied after ⏎ closes the input, so a filtered list can be navigated.
 */
export interface FilterState {
  typing: boolean;
  query: string;
}

export const NO_FILTER: FilterState = { typing: false, query: '' };

/** Case-insensitive substring match — predictable, unlike fuzzy matching, which is the point on a list of branch names. */
export function matchesFilter(text: string, query: string): boolean {
  return query === '' || text.toLowerCase().includes(query.toLowerCase());
}

/**
 * Routes a key into the filter, returning the next state or undefined when the
 * key means nothing to it and the view should handle it. Opening on '/' is only
 * offered while not already typing, so '/' is a literal character in a query.
 */
// fallow-ignore-next-line complexity
export function applyFilterKey(state: FilterState, key: Key): FilterState | undefined {
  if (!state.typing) {
    return key.name === 'char' && key.value === '/' ? { typing: true, query: '' } : undefined;
  }
  if (key.name === 'enter') return { typing: false, query: state.query };
  if (key.name === 'escape') return NO_FILTER;
  if (key.name === 'backspace') return { typing: true, query: state.query.slice(0, -1) };
  if (key.name === 'ctrl' && key.value === 'u') return { typing: true, query: '' };
  if (key.name === 'char') return { typing: true, query: state.query + key.value };
  return undefined;
}
