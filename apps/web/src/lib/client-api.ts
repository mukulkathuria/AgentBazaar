import { errorOf } from './http';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Idempotency-Key for retries of one user action. getRandomValues also works on plain-http origins. */
export function newIdempotencyKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

let refreshing: Promise<boolean> | null = null;

/** Single-flight so concurrent 401s use a rotating refresh token only once. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST' })
    .then(
      (r) => r.ok,
      () => false,
    )
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  json?: unknown;
  idempotencyKey?: string;
  accept?: string;
}

/** Browser call through the same-origin proxy, which adds the bearer token from the httpOnly cookie. */
export async function apiFetch(path: string, init: ApiInit = {}): Promise<Response> {
  const headers = new Headers({ accept: init.accept ?? 'application/json' });
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
  const send = () =>
    fetch(`/api/proxy${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && (await refreshSession())) res = await send();
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the store. Check your connection and try again.');
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const e = errorOf(body, res.status);
    throw new ApiError(res.status, e.code, e.message);
  }
  return res;
}

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const res = await apiFetch(path, init);
  return (await res.json()) as T;
}

/** API messages for 4xx errors are written for shoppers; anything else gets the localized fallback. */
export function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.message : fallback;
}
