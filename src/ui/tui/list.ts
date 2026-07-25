/**
 * Cursor and scrolling arithmetic for every selectable list in the TUI (home
 * menu, settings fields, session list, wizard choices). Pure functions rather
 * than a widget class, so each rule — wrapping at the ends, keeping the cursor
 * inside the viewport, clamping a stale index after the list shrinks — is
 * unit-testable on its own.
 */

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
