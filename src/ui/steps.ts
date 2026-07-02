/**
 * Friendly progress narration for `pipeline-worker run`: a bold, non-technical
 * headline per workflow step with a dim technical detail line underneath —
 * mirrors how Claude Code narrates its own tool calls, so a non-technical user
 * can follow along without reading source.
 */

import { styleText } from 'node:util';

export function step(title: string, detail?: string): void {
  console.log(styleText('bold', title));
  if (detail) console.log(styleText('dim', `  ${detail}`));
}
