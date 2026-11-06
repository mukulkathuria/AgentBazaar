import { AppError } from '../../../shared/kernel/errors.js';
import { CircuitBreaker, withTimeout } from '../../../shared/resilience/resilience.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonHttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * For creating indexes and writing batches: a busy engine needs seconds (Qdrant took 1.6 s to create
 * a collection on the test stack), far beyond what a search may take.
 */
export const WRITE_TIMEOUT_MS = 15_000;

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

  /**
   * Statuses in `allow` resolve to undefined instead of failing (e.g. 404 on delete). A string body
   * is sent as is, as NDJSON (bulk APIs); anything else as JSON. `timeoutMs` overrides the default.
   */
  request<T>(method: string, path: string, body?: unknown, allow: readonly number[] = [], timeoutMs?: number): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    const ndjson = typeof body === 'string';
    return this.breaker.exec(() =>
      withTimeout(async (signal) => {
        const res = await doFetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
          method,
          signal,
          headers: { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json', ...this.opts.headers },
          ...(body === undefined ? {} : { body: ndjson ? body : JSON.stringify(body) }),
        });
        if (allow.includes(res.status)) return undefined as T;
        if (!res.ok) throw new AppError('unavailable', `${this.name} answered HTTP ${res.status}`);
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }, timeoutMs ?? this.opts.timeoutMs ?? 2000),
    );
  }
}
