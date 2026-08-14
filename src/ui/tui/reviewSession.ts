/**
 * Runs the review picker (views/reviewPicker.ts) as a self-contained screen in
 * the middle of a plain-CLI run: the live tree renderer is paused, the alt
 * screen is taken for as long as the human needs it, and both are given back
 * before the run continues.
 *
 * The picker is a full-screen prompt on raw stdin, so it can only run where
 * nothing else owns those: two TTYs, and no TUI dashboard already driving the
 * run (inside `pipeline-worker tui` the app loop holds raw mode, and a second
 * reader would race it for every byte). Anywhere else this returns undefined
 * and the review posts every new finding, exactly as it did before.
 */

import { TuiApp } from './app.js';
import { ReviewPickerView } from './views/reviewPicker.js';
import { rendererIsDelegated, withDisplaySuspended } from '../steps.js';
import type { FindingSelector, SelectableFinding } from '../../review/selection.js';

/** Pure half of the gate, so the rule is testable without flipping process.stdin.isTTY on the terminal running the tests. */
export function pickerAvailable(stdinIsTty: boolean, stdoutIsTty: boolean, rendererDelegated: boolean): boolean {
  return stdinIsTty && stdoutIsTty && !rendererDelegated;
}

/** The selector to hand ReviewRound, or undefined when this terminal cannot host the picker. */
export function createFindingSelector(): FindingSelector | undefined {
  if (!pickerAvailable(process.stdin.isTTY === true, process.stdout.isTTY === true, rendererIsDelegated())) return undefined;
  return async (candidates, turn) => {
    if (candidates.length === 0) return [];
    return withDisplaySuspended(async () => {
      let selected: SelectableFinding[] | undefined;
      const view = new ReviewPickerView(turn, candidates, (result) => {
        selected = result;
      });
      await new TuiApp(view).run();
      return selected;
    });
  };
}
