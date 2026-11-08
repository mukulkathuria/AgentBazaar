import { SearchQuery } from '@agentbazaar/contracts';
import type { FetchLike } from '../../src/modules/search/infrastructure/json-http.js';
import { workload } from '../support/search-workload.js';
import type { RealEngines } from './real-engines.js';

interface Result {
  processingTimeMs?: number;
  semanticHitCount?: number;
}
interface Sample {
  q: string;
  total: number;
  http: number;
  page: number;
  counts: number;
  semantic: number;
  url: string;
  init: RequestInit;
  body: string;
}
type Query = Record<string, unknown>;

const ms = (x: number) => x.toFixed(1);
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]!;
const median = (xs: number[]) => percentile(xs, 0.5);

/** The same multi-search with one part changed, to see what that part costs. */
const VARIANTS: Record<string, (queries: Query[]) => Query[]> = {
  'as sent': (qs) => qs,
  'page only': (qs) => qs.slice(0, 1),
  'counts only': (qs) => qs.slice(1),
  'page without vector': (qs) =>
    qs.slice(0, 1).map((q) => Object.fromEntries(Object.entries(q).filter(([k]) => !['vector', 'hybrid', 'showRankingScore'].includes(k)))),
  'page, fewer attributes': (qs) => qs.slice(0, 1).map((q) => ({ ...q, attributesToRetrieve: ['id', 'slug', 'name', 'brand'] })),
};

/**
 * Where Meilisearch's search time goes, for docs/benchmarks/search.md: the mixed workload through the
 * adapter with Meilisearch's own processingTimeMs per query of the multi-search against the HTTP round
 * trip, then the five slowest queries re-sent with one part changed at a time (median of five).
 */
export async function profileMeilisearch(engines: RealEngines): Promise<string> {
  let last: Omit<Sample, 'q' | 'total'> | undefined;
  const recording: FetchLike = async (url, init) => {
    const started = performance.now();
    const res = await fetch(url, init);
    const text = await res.text();
    const results = (JSON.parse(text) as { results?: Result[] }).results ?? [];
    last = {
      http: performance.now() - started,
      page: results[0]?.processingTimeMs ?? 0,
      counts: results[1]?.processingTimeMs ?? 0,
      semantic: results[0]?.semanticHitCount ?? 0,
      url,
      init,
      body: typeof init.body === 'string' ? init.body : '{"queries":[]}',
    };
    return new Response(text, { status: res.status });
  };
  const adapter = engines.meilisearchWith({ fetch: recording });
  for (const q of workload(10)) await adapter.search(SearchQuery.parse(q));
  const samples: Sample[] = [];
  for (const q of workload(100)) {
    const started = performance.now();
    await adapter.search(SearchQuery.parse(q));
    samples.push({ q: JSON.stringify(q), total: performance.now() - started, ...last! });
  }
  const line = (name: string, xs: number[]) => `${name} p50=${ms(median(xs))} p95=${ms(percentile(xs, 0.95))} max=${ms(Math.max(...xs))}`;
  const out = [
    'meilisearch profile over 100 queries through the adapter (ms):',
    line('  adapter', samples.map((s) => s.total)),
    line('  http round trip', samples.map((s) => s.http)),
    line('  meilisearch page query', samples.map((s) => s.page)),
    line('  meilisearch count query', samples.map((s) => s.counts)),
  ];
  for (const s of [...samples].sort((a, b) => b.total - a.total).slice(0, 5)) {
    out.push(`  ${s.q}: adapter ${ms(s.total)}, http ${ms(s.http)}, page ${ms(s.page)}, counts ${ms(s.counts)}, semantic hits ${s.semantic}`);
    const queries = (JSON.parse(s.body) as { queries: Query[] }).queries;
    const variants: string[] = [];
    for (const [name, change] of Object.entries(VARIANTS)) {
      const runs: { http: number; processing: number }[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const res = await fetch(s.url, { ...s.init, signal: null, body: JSON.stringify({ queries: change(queries) }) });
        const results = ((await res.json()) as { results?: Result[] }).results ?? [];
        runs.push({ http: performance.now() - started, processing: results.reduce((n, r) => n + (r.processingTimeMs ?? 0), 0) });
      }
      variants.push(`${name} ${ms(median(runs.map((r) => r.http)))}/${ms(median(runs.map((r) => r.processing)))}`);
    }
    out.push(`    http/meilisearch ms: ${variants.join('; ')}`);
  }
  return out.join('\n');
}
