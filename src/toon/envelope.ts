/**
 * TOON response envelope for the GitLab MCP server's tools.
 *
 * Ports the response conventions already established in this repo family's
 * files-mcp/server.py (status / aggregate counts / chars / truncate-with-
 * `full=true` escape hatch / trailing `next:` hint) to TypeScript, but
 * delegates the actual TOON row/table encoding to the real `@toon-format/toon`
 * package instead of hand-rolling `name[N]{cols}:` header logic.
 */

import { encode } from '@toon-format/toon';

const DEFAULT_MAX_CHARS = 8000;

export interface Envelope {
  status: 'success' | 'error';
  data?: unknown;
  counts?: Record<string, number>;
  next?: string;
}

export interface EnvelopeOptions {
  maxChars?: number;
  full?: boolean;
}

function encodeBody(data: unknown, full: boolean | undefined, maxChars: number): { body: string; truncated: boolean } {
  const body = data !== undefined ? encode(data) : '';
  const truncated = !full && body.length > maxChars;
  return { body, truncated };
}

function renderCountsLines(counts: Record<string, number> | undefined): string[] {
  if (!counts) return [];
  return Object.entries(counts).map(([key, value]) => `${key}: ${value}`);
}

function renderBodyBlock(body: string, truncated: boolean, maxChars: number): string[] {
  if (!body) return [];
  return [`chars: ${body.length}`, '---', truncated ? body.slice(0, maxChars) : body, '---'];
}

function renderTrailer(truncated: boolean, maxChars: number, bodyLength: number, next: string | undefined): string[] {
  if (truncated) {
    return [`note: truncated to ${maxChars} of ${bodyLength} chars`, 'next: call again with full=true to see the rest'];
  }
  if (next) return [`next: ${next}`];
  return [];
}

export function buildEnvelope(env: Envelope, opts: EnvelopeOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const { body, truncated } = encodeBody(env.data, opts.full, maxChars);

  const lines = [
    `status: ${env.status}`,
    ...renderCountsLines(env.counts),
    ...renderBodyBlock(body, truncated, maxChars),
    ...renderTrailer(truncated, maxChars, body.length, env.next),
  ];

  return lines.join('\n');
}

export function errorEnvelope(kind: string, message: string): string {
  return `status: error\nkind: ${kind}\nmessage: ${message}`;
}
