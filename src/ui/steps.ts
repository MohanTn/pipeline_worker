/**
 * Friendly progress narration for `pipeline-worker run`: a bold, non-technical
 * headline per workflow step with a dim technical detail line underneath —
 * mirrors how Claude Code narrates its own tool calls, so a non-technical user
 * can follow along without reading source.
 */

import { styleText } from 'node:util';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A one-off status line with no associated work to wait on (e.g. a final summary). */
export function step(title: string, detail?: string): void {
  console.log(styleText('bold', title));
  if (detail) console.log(styleText('dim', `  ${detail}`));
}

/**
 * An indented supplementary detail line under the current step (e.g. an
 * agent's summary, a result). Input is freeform (agent output, forge data)
 * with no single-line guarantee, so collapse any embedded newlines —
 * otherwise a multi-line value would break out of the "one dim line" format.
 */
export function note(text: string): void {
  console.log(styleText('dim', `  ${text.replace(/\s*\n\s*/g, ' ')}`));
}

/**
 * Runs one workflow step with a bold title, then a live status line beneath
 * it while `task` runs: a spinner plus a counting-up elapsed timer in a TTY,
 * settling into a checkmark/cross with the total duration on completion.
 * Falls back to a single static print when stdout isn't a TTY (CI logs,
 * redirected files) since carriage-return spinners would just garble those.
 */
export async function runStep<T>(title: string, detail: string, task: () => Promise<T>): Promise<T> {
  console.log(styleText('bold', title));

  if (!process.stdout.isTTY) {
    console.log(styleText('dim', `  ${detail}`));
    return task();
  }

  const start = Date.now();
  let frame = 0;
  const render = (glyph: string): void => {
    process.stdout.write(`\r\x1b[K${styleText('dim', `  ${glyph} ${detail} (${formatElapsed(Date.now() - start)})`)}`);
  };
  render(SPINNER_FRAMES[0]);
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    render(SPINNER_FRAMES[frame]);
  }, SPINNER_INTERVAL_MS);

  try {
    const result = await task();
    clearInterval(timer);
    render('✓');
    process.stdout.write('\n');
    return result;
  } catch (error) {
    clearInterval(timer);
    render('✗');
    process.stdout.write('\n');
    throw error;
  }
}
