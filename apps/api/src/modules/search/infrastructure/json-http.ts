import { AppError } from '../../../shared/kernel/errors.js';
import { CircuitBreaker, withTimeout } from '../../../shared/resilience/resilience.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonHttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** JSON over plain `fetch` with a timeout and a circuit breaker, for search engines and the AI service. */
export class JsonHttp {
  private readonly breaker: CircuitBreaker;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly opts: JsonHttpOptions = {},
  ) {
    this.breaker = new CircuitBreaker(name);
  }

  /** Statuses in `allow` resolve to undefined instead of failing (e.g. 404 on delete). */
  request<T>(method: string, path: string, body?: unknown, allow: readonly number[] = []): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    return this.breaker.exec(() =>
      withTimeout(async (signal) => {
        const res = await doFetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
          method,
          signal,
          headers: { 'content-type': 'application/json', ...this.opts.headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (allow.includes(res.status)) return undefined as T;
        if (!res.ok) throw new AppError('unavailable', `${this.name} answered HTTP ${res.status}`);
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }, this.opts.timeoutMs ?? 2000),
    );
  }
}
