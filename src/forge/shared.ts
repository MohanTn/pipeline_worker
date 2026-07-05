/** Small pieces genuinely identical between the GitHub and GitLab ForgeClient implementations. */

/** Performs `fetch` and throws a labeled error on a non-ok response; the caller supplies the URL and headers since those differ per forge. */
// fallow-ignore-next-line complexity
export async function forgeFetch(apiLabel: string, path: string, url: string, headers: Record<string, string>, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${apiLabel} ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText} — ${body}`);
  }
  return res;
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
