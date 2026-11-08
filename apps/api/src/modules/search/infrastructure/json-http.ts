import http from 'node:http';
import https from 'node:https';
import { AppError } from '../../../shared/kernel/errors.js';
import { CircuitBreaker, withTimeout } from '../../../shared/resilience/resilience.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
/** Statuses that carry no body; the Response constructor rejects one. */
const NO_BODY = new Set([204, 205, 304]);

/**
 * fetch over node:http(s) on kept-alive connections. Node's built-in fetch (undici) waited about 40 ms on
 * Meilisearch's chunked responses; node:http took 1.4 to 6.4 ms for the same requests (docs/benchmarks/search.md).
 */
export const nodeFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = typeof init.body === 'string' ? init.body : undefined;
    const headers = { ...(init.headers as Record<string, string>), ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) };
    const options: http.RequestOptions = { method: init.method ?? 'GET', headers, signal: init.signal ?? undefined };
    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        resolve(new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status }));
      });
    };
    const req =
      target.protocol === 'https:'
        ? https.request(target, { ...options, agent: httpsAgent }, onResponse)
        : http.request(target, { ...options, agent: httpAgent }, onResponse);
    req.on('error', reject);
    req.end(body);
  });

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

/** JSON over HTTP (`nodeFetch` unless a fetch is given) with a timeout and a circuit breaker, for search engines and the AI service. */
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
    const doFetch = this.opts.fetch ?? nodeFetch;
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
