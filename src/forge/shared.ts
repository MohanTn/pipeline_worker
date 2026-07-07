/** Small pieces genuinely identical between the GitHub and GitLab ForgeClient implementations. */

export interface ForgeRetryConfig {
  /** Number of retries after the initial attempt (so maxRetries=4 means up to 5 total requests). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<ForgeRetryConfig> = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 (rate limited) and 5xx (forge-side failure) are worth retrying; every other 4xx (401/403/404/422, ...) means retrying would just repeat the same rejection. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Parses a `Retry-After` header (either delta-seconds or an HTTP-date) into milliseconds; undefined if absent or unparseable. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter, capped at maxDelayMs; a Retry-After value (also capped, since a forge could send an unreasonably long one) takes priority when present. */
function backoffMs(attempt: number, cfg: Required<ForgeRetryConfig>, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, cfg.maxDelayMs * 4);
  return Math.random() * Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
}

/**
 * Performs `fetch` with bounded retry/backoff, then throws a labeled error on
 * a non-ok response that's either non-retryable or has exhausted its
 * retries. The caller supplies the URL and headers since those differ per
 * forge. Over a long CI-watch poll loop (up to 2 hours at ~15s intervals) a
 * transient 429/5xx/network blip is expected sooner or later; without this,
 * one such blip crashes the whole run and forces a manual `pipeline-worker
 * resume`. Only 429/5xx and thrown network errors are retried — other 4xx
 * (401/403/404/422, ...) fail on the first attempt, since retrying an auth or
 * not-found error only delays surfacing a real problem.
 */
// fallow-ignore-next-line complexity
export async function forgeFetch(
  apiLabel: string,
  path: string,
  url: string,
  headers: Record<string, string>,
  init?: RequestInit,
  retryConfig?: ForgeRetryConfig,
): Promise<Response> {
  const cfg: Required<ForgeRetryConfig> = { ...DEFAULT_RETRY, ...retryConfig };
  const method = init?.method ?? 'GET';

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    } catch (networkError) {
      if (attempt >= cfg.maxRetries) {
        const message = networkError instanceof Error ? networkError.message : String(networkError);
        throw new Error(`${apiLabel} ${method} ${path} failed after ${attempt + 1} attempt(s): ${message}`);
      }
      await sleep(backoffMs(attempt, cfg, undefined));
      continue;
    }

    if (res.ok) return res;
    if (!isRetryableStatus(res.status) || attempt >= cfg.maxRetries) {
      const body = await res.text().catch(() => '');
      throw new Error(`${apiLabel} ${method} ${path} failed: ${res.status} ${res.statusText} — ${body}`);
    }

    const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : undefined;
    await sleep(backoffMs(attempt, cfg, retryAfterMs));
  }
}

/** The `list.length > 0 ? map(list[0]) : undefined` idiom shared by both findExistingMr implementations. */
export function firstOrUndefined<T, R>(list: T[], map: (item: T) => R): R | undefined {
  return list.length > 0 ? map(list[0]) : undefined;
}

/** Both createMrNote implementations parse the response the same way, just against differently-shaped request paths. */
export async function parseIdResponse(res: Response): Promise<{ id: number }> {
  const note = (await res.json()) as { id: number };
  return { id: note.id };
}
