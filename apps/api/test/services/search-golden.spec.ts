import { SearchQuery } from '@agentbazaar/contracts';
import { generateCatalog, type SeedCatalog } from '@agentbazaar/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsService, PgAnalyticsStore } from '../../src/modules/analytics/index.js';
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
import { profileMeilisearch } from './meili-profile.js';
import { realEngines, type RealEngines } from './real-engines.js';

/** CI indexes 10,000 products; SEARCH_BENCH_PRODUCTS=100000 is the published run (docs/benchmarks/search.md). */
const PRODUCTS = Number(process.env.SEARCH_BENCH_PRODUCTS ?? 10_000);
/**
 * The plan's budget (p95 under 50 ms) is for 100,000 products, measured by the Search benchmark workflow on a
 * runner with only the search engines. The 10,000-product run shares the Services runner with eleven services
 * and a dozen suites, where the same code measured 47 to 53 ms, so there it only catches regressions of the
 * size the golden set found (rankingScoreThreshold made p95 1,176 ms).
 */
const P95_BUDGET_MS = PRODUCTS >= 100_000 ? 50 : 100;
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
  /** SearchService per engine: the REST and MCP code path, Hindi query terms included. */
  let services: Record<Engine, SearchService>;
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
      const service = (port: SearchPort) => new SearchService(port, new AnalyticsService(db, new PgAnalyticsStore(db)), db, createLogger('silent'));
      services = { postgres: service(ports.postgres), meilisearch: service(ports.meilisearch), opensearch: service(ports.opensearch) };
    },
    Math.max(600_000, PRODUCTS * 36),
  );
  afterAll(async () => {
    await engines?.drop();
    await t?.cleanup();
  });

  it('scores growth at least as high as lite, and scale at parity with growth', { timeout: 600_000 }, async () => {
    const golden = goldenQueries(seed);
    expect(golden.length).toBeGreaterThanOrEqual(60);
    const scores = {} as Record<Engine, GoldenScore>;
    for (const name of ENGINES) scores[name] = await scoreGolden(golden, (q) => services[name].search(q));
    console.warn(report(golden, scores));
    expect(scores.meilisearch.recall).toBeGreaterThanOrEqual(scores.postgres.recall);
    expect(scores.opensearch.recall).toBeGreaterThanOrEqual(scores.meilisearch.recall);
    // Devanagari queries reach every engine through SearchService's Hindi terms.
    for (const name of ENGINES) expect(scores[name].byKind.hindi, name).toBeGreaterThanOrEqual(0.9);
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
    const budget = name === 'postgres' ? Infinity : P95_BUDGET_MS;
    it(`${name} answers 100 mixed queries through SearchService${budget < Infinity ? ` with p95 under ${budget} ms` : ''}`, { retry: 2, timeout: 600_000 }, async () => {
      const { p50, p95, max, slowest } = await measureLatency(services[name]);
      console.warn(`${name} search latency over 100 queries, ${PRODUCTS} products: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
      console.warn(`${name} slowest: ${slowest}`);
      expect(p95).toBeLessThan(budget);
    });
  }

  it.runIf(process.env.SEARCH_BENCH_PROFILE)('profiles where Meilisearch spends its time', { timeout: 600_000 }, async () => {
    console.warn(await profileMeilisearch(engines));
  });
});
