/**
 * The list-of-choices view every menu-shaped screen in the TUI is built from
 * (the home screen, the wizard's enum steps). Holds the cursor, paints the
 * rows with their descriptions, and delegates "what does picking this mean" to
 * each item's own onSelect.
 */

import { seg, type Line } from '../line.js';
import { moveIndex, viewportWindow } from '../list.js';
import { NONE, type Action, type RenderedView, type View } from '../view.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';

export interface MenuItem {
  label: string;
  /** One line under the label explaining what choosing it does. */
  description?: string;
  onSelect(): Action | Promise<Action>;
}

/** Rows each item occupies: its label, plus a description line the cursor shares. */
const ROWS_PER_ITEM = 2;

export class MenuView implements View {
  private index = 0;
  private windowStart = 0;

  constructor(
    private readonly title: string,
    private readonly items: readonly MenuItem[],
    private readonly header: Line[] = [],
    private readonly hints = '↑↓ move · ⏎ select · q quit',
  ) {}

  render(inner: Size): RenderedView {
    const available = Math.max(1, inner.rows - this.header.length);
    const perScreen = Math.max(1, Math.floor(available / ROWS_PER_ITEM));
    const { start, end } = viewportWindow(this.index, this.items.length, perScreen, this.windowStart);
    this.windowStart = start;

    const body: Line[] = [...this.header];
    for (let i = start; i < end; i++) {
      const item = this.items[i];
      const selected = i === this.index;
      body.push([
        seg(selected ? ' ❯ ' : '   ', { role: 'sky', bold: true }),
        seg(item.label, { bold: selected, role: selected ? 'sky' : undefined }),
      ]);
      body.push([seg(`     ${item.description ?? ''}`, { role: 'overlay1' })]);
    }
    return { title: this.title, body, hints: this.hints };
  }

  onKey(key: Key): Action | Promise<Action> {
    if (key.name === 'up') this.index = moveIndex(this.index, -1, this.items.length);
    else if (key.name === 'down') this.index = moveIndex(this.index, 1, this.items.length);
    else if (key.name === 'enter') return this.items[this.index]?.onSelect() ?? NONE;
    return NONE;
  }
}
