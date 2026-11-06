import type { SearchQueryInput, SearchService } from '../../src/modules/search/application/search.service.js';

const TEXT = [
  'gpu 12gb', 'mechanical keyboard', 'keybaord', 'chocolate', 'dark chocolate', 'green tea', 'assam tea', 'coffee mug',
  'ceramic mug', 'wireless mouse', 'gaming mouse', 'power supply 850w', 'modular psu', 'mid tower case', 'cotton t-shirt',
  'oversized tshirt', 'dotted journal', 'spiral notebook', 'zentrix', 'THOCK-TK87-RED', 'graphics card 24gb', 'chocolat',
  'hazelnut', 'darjeeling first flush', 'xyzzy',
];
const FILTERS: Partial<SearchQueryInput>[] = [
  {},
  { inStockOnly: true },
  { category: 'food' },
  { maxPricePaise: 100_000 },
  { category: 'electronics', minPricePaise: 500_000 },
  { brand: 'Thock' },
];

/** Mixed workload: text queries (with typos and SKUs), filters, browsing and second pages. */
export const workload = (n: number): SearchQueryInput[] =>
  Array.from({ length: n }, (_, i) => ({
    q: i % 5 === 4 ? '' : TEXT[i % TEXT.length],
    ...FILTERS[i % FILTERS.length],
    offset: i % 7 === 0 ? 12 : 0,
  }));

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

export interface Latency {
  p50: number;
  p95: number;
  max: number;
  /** The three slowest queries, to tell which part of the workload costs most. */
  slowest: string;
}

/** Warms up with 10 queries, then times `n` through SearchService (the REST and MCP code path). */
export async function measureLatency(service: SearchService, n = 100): Promise<Latency> {
  for (const q of workload(10)) await service.search(q);
  const runs: { q: SearchQueryInput; ms: number }[] = [];
  for (const q of workload(n)) {
    const started = performance.now();
    await service.search(q);
    runs.push({ q, ms: performance.now() - started });
  }
  const timings = runs.map((r) => r.ms).sort((a, b) => a - b);
  const slowest = [...runs].sort((a, b) => b.ms - a.ms).slice(0, 3);
  return {
    p50: percentile(timings, 0.5),
    p95: percentile(timings, 0.95),
    max: timings[timings.length - 1]!,
    slowest: slowest.map((r) => `${r.ms.toFixed(0)}ms ${JSON.stringify(r.q)}`).join(', '),
  };
}
