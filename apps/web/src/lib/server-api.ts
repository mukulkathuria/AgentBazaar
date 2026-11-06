import { cookies, headers } from 'next/headers';
import { API_URL } from './env';
import { errorOf } from './http';
import { COOKIE } from './session';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Public catalogue data only: kept in Next's data cache and sent without the shopper's credentials. */
  cache?: { revalidate: number; tags?: string[] };
  idempotencyKey?: string;
}

const UNAVAILABLE = {
  ok: false,
  status: 503,
  code: 'unavailable',
  message: 'The store is temporarily unavailable. Please try again shortly.',
} as const;

/** Server-side API call. Never throws: network failures and API errors come back as `{ ok: false }`. */
export async function callApi<T>(path: string, opts: CallOptions = {}): Promise<ApiResult<T>> {
  const url = new URL(path, API_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const h = new Headers({ accept: 'application/json' });
  if (opts.body !== undefined) h.set('content-type', 'application/json');
  if (opts.idempotencyKey) h.set('idempotency-key', opts.idempotencyKey);
  if (!opts.cache) await addCallerHeaders(h);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: h,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(10_000),
      ...(opts.cache ? { next: opts.cache } : { cache: 'no-store' as const }),
    });
    const body: unknown = await res.json().catch(() => null);
    return res.ok ? { ok: true, data: body as T } : { ok: false, status: res.status, ...errorOf(body, res.status) };
  } catch {
    return UNAVAILABLE;
  }
}

async function addCallerHeaders(h: Headers): Promise<void> {
  const token = (await cookies()).get(COOKIE.access)?.value;
  if (token) h.set('authorization', `Bearer ${token}`);
  // Lets the API rate-limit per shopper rather than per web server.
  const forwardedFor = (await headers()).get('x-forwarded-for');
  if (forwardedFor) h.set('x-forwarded-for', forwardedFor);
}
