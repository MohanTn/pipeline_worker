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

export function buildEnvelope(env: Envelope, opts: EnvelopeOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const body = env.data !== undefined ? encode(env.data) : '';
  const truncated = !opts.full && body.length > maxChars;

  const lines = [`status: ${env.status}`];

  if (env.counts) {
    for (const [key, value] of Object.entries(env.counts)) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (body) {
    lines.push(`chars: ${body.length}`, '---', truncated ? body.slice(0, maxChars) : body, '---');
  }

  if (truncated) {
    lines.push(`note: truncated to ${maxChars} of ${body.length} chars`, 'next: call again with full=true to see the rest');
  } else if (env.next) {
    lines.push(`next: ${env.next}`);
  }

  return lines.join('\n');
}

export function errorEnvelope(kind: string, message: string): string {
  return `status: error\nkind: ${kind}\nmessage: ${message}`;
}
