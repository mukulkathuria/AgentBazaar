import { SearchQuery } from '@agentbazaar/contracts';
import { generateCatalog, type SeedCatalog } from '@agentbazaar/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsService } from '../../src/modules/analytics/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { InventoryService } from '../../src/modules/inventory/index.js';
import type { SearchPort } from '../../src/modules/search/application/ports.js';
import { SearchIndexer } from '../../src/modules/search/application/search-indexer.js';
import { SearchService } from '../../src/modules/search/application/search.service.js';
import { HashEmbeddings } from '../../src/modules/search/domain/embeddings.js';
import { PgSearchAdapter } from '../../src/modules/search/infrastructure/pg-search.adapter.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { systemClock } from '../../src/shared/kernel/clock.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import { goldenQueries, scoreGolden, type GoldenQuery, type GoldenScore } from '../support/search-golden.js';
import { measureLatency } from '../support/search-workload.js';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { realEngines, type RealEngines } from './real-engines.js';

/** CI indexes 10,000 products; SEARCH_BENCH_PRODUCTS=100000 is the published run (docs/benchmarks/search.md). */
const PRODUCTS = Number(process.env.SEARCH_BENCH_PRODUCTS ?? 10_000);
const ENGINES = ['postgres', 'meilisearch', 'opensearch'] as const;
type Engine = (typeof ENGINES)[number];
const seconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1);

function report(golden: readonly GoldenQuery[], scores: Record<Engine, GoldenScore>): string {
  const f = (x: number) => x.toFixed(3);
  const misses = golden
    .map((g, i) => ({ q: JSON.stringify(g.query), r: ENGINES.map((e) => scores[e].perQuery[i]!) }))
    .filter((m) => m.r.some((x) => x.recall < 1))
    .map((m) => `  ${m.q}: ${m.r.map((x) => f(x.recall)).join(' / ')}; not relevant: ${m.r.map((x) => x.irrelevant.slice(0, 3).join(' ') || '-').join(' / ')}`);
  return [
    `golden set, ${golden.length} queries over ${PRODUCTS} products (engine: recall@10, nDCG@10, recall@10 by kind)`,
    ...ENGINES.map((e) => `${e}: ${f(scores[e].recall)}, ${f(scores[e].ndcg)}, ${JSON.stringify(scores[e].byKind)}`),
    `queries below full recall (${ENGINES.join(' / ')}):`,
    ...misses,
  ].join('\n');
}

describe(`@growth @scale golden search queries and latency at ${PRODUCTS} products`, () => {
  let t: TestDb;
  let seed: SeedCatalog;
  let engines: RealEngines;
  let ports: Record<Engine, SearchPort>;
  const embeddings = new HashEmbeddings();

  beforeAll(
    async () => {
      // Bulk loading and VACUUM at 100,000 products outlast the API's 15 s statement timeout.
      t = await createTestDb({ poolMax: 8, statementTimeoutMs: 600_000 });
      const db = t.database.db;
      const catalog = new CatalogService(db, new InventoryService(db, systemClock));
      seed = generateCatalog({ products: PRODUCTS });
      let started = performance.now();
      await inTransaction(db, (tx) => catalog.importSeed(tx, seed, new Map()));
      console.warn(`imported ${PRODUCTS} products in ${seconds(started)} s`);
      engines = realEngines('golden', embeddings);
      ports = { postgres: new PgSearchAdapter(db, embeddings), meilisearch: engines.meilisearch, opensearch: engines.opensearch };
      for (const name of ENGINES) {
        started = performance.now();
        expect(await new SearchIndexer(ports[name], embeddings, catalog).reindexAll(), name).toBe(PRODUCTS);
        await engines.settle(3_600_000);
        console.warn(`reindex into ${name}: ${PRODUCTS} products searchable after ${seconds(started)} s`);
      }
      // Steady state, as in production: hint bits set, visibility map and statistics current.
      await t.database.query('VACUUM ANALYZE search_documents');
    },
    Math.max(600_000, PRODUCTS * 36),
  );
  afterAll(async () => {
    await engines?.drop();
    await t?.cleanup();
  });

  it('scores growth at least as high as lite, and scale at parity with growth', { timeout: 600_000 }, async () => {
    const golden = goldenQueries(seed);
    expect(golden.length).toBeGreaterThanOrEqual(50);
    const scores = {} as Record<Engine, GoldenScore>;
    for (const name of ENGINES) scores[name] = await scoreGolden(golden, (q) => ports[name].search(q));
    console.warn(report(golden, scores));
    expect(scores.meilisearch.recall).toBeGreaterThanOrEqual(scores.postgres.recall);
    expect(scores.opensearch.recall).toBeGreaterThanOrEqual(scores.meilisearch.recall);
  });

  it.skipIf(PRODUCTS < 5050)('pages to the deepest page the API allows and reports exact browse totals in every engine', async () => {
    for (const name of ENGINES) {
      const r = await ports[name].search(SearchQuery.parse({ offset: 5000, limit: 50 }));
      expect(r.total, name).toBe(PRODUCTS);
      expect(r.items, name).toHaveLength(50);
    }
  });

  // Retried because a busy shared machine can stall a few queries; each attempt is a full, honest run.
  for (const name of ENGINES) {
    const budget = name === 'postgres' ? Infinity : 50;
    it(`${name} answers 100 mixed queries through SearchService${budget < Infinity ? ' with p95 under 50 ms' : ''}`, { retry: 2, timeout: 600_000 }, async () => {
      const db = t.database.db;
      const { p50, p95, max, slowest } = await measureLatency(new SearchService(ports[name], new AnalyticsService(db), db, createLogger('silent')));
      console.warn(`${name} search latency over 100 queries, ${PRODUCTS} products: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
      console.warn(`${name} slowest: ${slowest}`);
      expect(p95).toBeLessThan(budget);
    });
  }
});
