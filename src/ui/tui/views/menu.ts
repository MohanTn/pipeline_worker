/**
 * The list-of-choices view every menu-shaped screen in the TUI is built from
 * (the home screen, the wizard's enum steps). Holds the cursor, paints the
 * rows, and delegates "what does picking this mean" to each item's own
 * onSelect.
 *
 * Only the focused item shows its description. Printing one under every row
 * halves how many choices fit on screen to explain the four the user is not
 * looking at, and a menu the eye can take in at once is worth more than
 * always-on prose.
 */

import { seg, type Line } from '../line.js';
import { selectionRow } from '../chrome.js';
import { applyFilterKey, applyNav, clampIndex, matchesFilter, navIntent, NO_FILTER, viewportWindow, type FilterState } from '../list.js';
import { HINT, NONE, hints, isBackKey, type Action, type RenderedView, type View } from '../view.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';

export interface MenuItem {
  label: string;
  /** One line under the label explaining what choosing it does, shown while it is focused. */
  description?: string;
  onSelect(): Action | Promise<Action>;
}

/** Rows reserved below the list for the focused item's description. */
const DESCRIPTION_ROWS = 1;

export class MenuView implements View {
  private index = 0;
  private windowStart = 0;
  private filter: FilterState = NO_FILTER;

  constructor(
    private readonly title: string,
    private readonly items: readonly MenuItem[],
    private readonly header: Line[] = [],
    private readonly hintOverride?: string,
  ) {}

  /** The items the filter lets through — what the cursor actually indexes. */
  private visible(): readonly MenuItem[] {
    if (this.filter.query === '') return this.items;
    return this.items.filter((item) => matchesFilter(item.label, this.filter.query));
  }

  private focused(): MenuItem | undefined {
    const visible = this.visible();
    return visible[clampIndex(this.index, visible.length)];
  }

  /** The '/' input line, or the standing filter once ⏎ has closed the input. */
  private filterRow(): Line | undefined {
    if (this.filter.typing) return [seg('/', { role: 'mauve', bold: true }), seg(this.filter.query), seg(' ', { invert: true })];
    if (this.filter.query === '') return undefined;
    return [seg('/', { role: 'mauve' }), seg(this.filter.query, { role: 'mauve' }), seg(`  ${this.visible().length} of ${this.items.length}`, { role: 'overlay1' })];
  }

  render(inner: Size): RenderedView {
    const visible = this.visible();
    this.index = clampIndex(this.index, visible.length);
    const filterRow = this.filterRow();
    const reserved = this.header.length + (filterRow ? 1 : 0) + DESCRIPTION_ROWS;
    const perScreen = Math.max(1, inner.rows - reserved);
    const { start, end } = viewportWindow(this.index, visible.length, perScreen, this.windowStart);
    this.windowStart = start;

    const body: Line[] = [...this.header];
    if (visible.length === 0) body.push([seg(`no match for "${this.filter.query}"`, { role: 'overlay1' })]);
    for (let i = start; i < end; i++) {
      const item = visible[i];
      const selected = i === this.index;
      body.push(selectionRow([seg(' '), seg(item.label)], inner.columns, selected));
      if (selected && item.description) body.push([seg(`    ${item.description}`, { role: 'subtext0' })]);
    }
    if (filterRow) body.push([], filterRow);

    return { title: this.title, body, hints: this.hints() };
  }

  private hints(): string {
    if (this.filter.typing) return hints(HINT.filtering, HINT.clear);
    return this.hintOverride ?? hints(HINT.move, '⏎ select', HINT.filter, HINT.quit);
  }

  onKey(key: Key): Action | Promise<Action> {
    const filtered = applyFilterKey(this.filter, key);
    if (filtered) {
      this.filter = filtered;
      this.index = 0;
      return NONE;
    }
    // While typing, letters belong to the query, so navigation and 'q' are off.
    if (this.filter.typing) return NONE;
    const nav = navIntent(key);
    if (nav) {
      this.index = applyNav(nav, this.index, this.visible().length);
      return NONE;
    }
    if (key.name === 'enter') return this.focused()?.onSelect() ?? NONE;
    // esc/q clears a standing filter before it leaves the screen, so a filtered
    // list never strands the user on a subset with no visible way back.
    if (isBackKey(key)) {
      if (this.filter.query === '') return { type: 'pop' };
      this.filter = NO_FILTER;
    }
    return NONE;
  }
}
