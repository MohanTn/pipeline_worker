/**
 * Friendly progress narration for `pipeline-worker run`: a bold, colored,
 * numbered headline per workflow step (with an icon and a "[n/TOTAL_STAGES]"
 * counter) and a dim technical detail line underneath — mirrors how Claude
 * Code narrates its own tool calls, so a non-technical user can follow along
 * without reading source.
 */

import { styleText } from 'node:util';
import type { RiskLevel } from '../types.js';

const RISK_COLOR: Record<RiskLevel, 'green' | 'yellow' | 'red'> = { low: 'green', medium: 'yellow', high: 'red' };

/**
 * The workflow always runs stages 1-9 once in order, then stage 10 (watching
 * the pipeline, and fixing/escalating on failure) until it resolves — so
 * every step, including the CI-fix loop's sub-steps, is stage 10.
 */
export const TOTAL_STAGES = 10;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function stageHeader(stage: number, icon: string, title: string): string {
  return styleText(['bold', 'cyan'], `[${stage}/${TOTAL_STAGES}] ${icon} ${title}`);
}

/** A one-off status line with no associated work to wait on (e.g. a final summary). */
export function step(icon: string, title: string, detail?: string): void {
  console.log(); // blank line for clear separation between stages
  console.log(styleText('bold', `${icon} ${title}`));
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

/** Like note(), but colors the text by risk level (green/yellow/red for low/medium/high). */
export function noteRisk(risk: RiskLevel, reason: string): void {
  console.log(styleText('dim', '  ') + styleText(RISK_COLOR[risk], `risk: ${risk} — ${reason.replace(/\s*\n\s*/g, ' ')}`));
}

/**
 * Runs one numbered workflow stage with a colored, iconed title, then a live
 * status line beneath it while `task` runs: a spinner plus a counting-up
 * elapsed timer in a TTY, settling into a green checkmark or red cross with
 * the total duration on completion. Falls back to a single static print when
 * stdout isn't a TTY (CI logs, redirected files) since carriage-return
 * spinners would just garble those.
 */
export async function runStep<T>(stage: number, icon: string, title: string, detail: string, task: () => Promise<T>): Promise<T> {
  console.log(); // blank line for clear separation between stages
  console.log(stageHeader(stage, icon, title));

  if (!process.stdout.isTTY) {
    console.log(styleText('dim', `  ${detail}`));
    return task();
  }

  const start = Date.now();
  let frame = 0;
  const render = (glyph: string, color: 'dim' | 'green' | 'red' = 'dim'): void => {
    process.stdout.write(`\r\x1b[K${styleText(color, `  ${glyph} ${detail} (${formatElapsed(Date.now() - start)})`)}`);
  };
  render(SPINNER_FRAMES[0]);
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    render(SPINNER_FRAMES[frame]);
  }, SPINNER_INTERVAL_MS);

  try {
    const result = await task();
    clearInterval(timer);
    render('✓', 'green');
    process.stdout.write('\n');
    return result;
  } catch (error) {
    clearInterval(timer);
    render('✗', 'red');
    process.stdout.write('\n');
    throw error;
  }
}
