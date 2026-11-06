/** Fills `{param}` placeholders of a contracts `Routes` path (URL-encoded) and appends a query string. */
export function apiPath(
  template: string,
  params: Record<string, string> = {},
  query: Record<string, string | undefined> = {},
): string {
  const path = template.replace(/\{(\w+)\}/g, (_m, key: string) => encodeURIComponent(params[key] ?? ''));
  const entries = Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined);
  const qs = new URLSearchParams(entries).toString();
  return qs ? `${path}?${qs}` : path;
}

export function errorJson(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** Extracts `{ code, message }` from the API error envelope, with a safe fallback. */
export function errorOf(body: unknown, status: number): { code: string; message: string } {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (typeof e?.code === 'string' && typeof e.message === 'string') return { code: e.code, message: e.message };
  if (status === 404) return { code: 'not_found', message: 'Not found' };
  return { code: 'internal', message: 'Something went wrong. Please try again.' };
}

/** CSRF guard for cookie-authenticated, state-changing requests. */
export function isSameOrigin(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = headers.get('origin');
  if (!origin) return true; // non-browser clients carry no ambient cookies
  try {
    return new URL(origin).host === headers.get('host');
  } catch {
    return false;
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return (await req.json()) as unknown;
  } catch {
    return null;
  }
}
