/**
 * Prompt assembly for the adapters whose CLI has no `--system-prompt` /
 * `--json-schema` flag (copilot, pi, little-coder): the system instruction and
 * the schema requirement are folded into the prompt text itself, in that
 * order, so those turns are still scoped as narrowly as the claude adapter's
 * are by real flags.
 *
 * Also holds the context-window budget used by the little-coder adapter —
 * kept here rather than in that adapter so it can be unit-tested without
 * spawning anything.
 */

export interface PromptParts {
  systemPrompt?: string;
  prompt: string;
  jsonSchema?: object;
}

const SCHEMA_INSTRUCTION = 'Respond with ONLY a single JSON object matching this JSON Schema — no prose, no code fences:';

/** System instruction first, task second, output contract last — the order every one of these CLIs reads best. */
export function composePrompt(parts: PromptParts): string {
  const blocks: string[] = [];
  if (parts.systemPrompt) blocks.push(parts.systemPrompt);
  blocks.push(parts.prompt);
  if (parts.jsonSchema) blocks.push(`${SCHEMA_INSTRUCTION}\n${JSON.stringify(parts.jsonSchema)}`);
  return blocks.join('\n\n');
}

/** Marker left in place of what was dropped, so a truncated prompt never reads as a complete one. */
const TRUNCATION_MARKER = '\n\n[... pipeline-worker truncated the middle of this prompt to fit the model context ...]\n\n';

/**
 * Trims a prompt to `maxChars` by dropping its *middle*, keeping the head (the
 * system instruction and task) and the tail (the output contract) — the two
 * parts a small model cannot do without. `maxChars` of 0 (or a budget too
 * small to hold the marker) disables trimming; callers treat this as
 * best-effort framing, not a guarantee about tokens, since only the model's
 * own tokenizer knows the real count.
 */
// fallow-ignore-next-line complexity
export function truncateToBudget(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const keep = maxChars - TRUNCATION_MARKER.length;
  if (keep <= 0) return text;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}${TRUNCATION_MARKER}${tail > 0 ? text.slice(-tail) : ''}`;
}
