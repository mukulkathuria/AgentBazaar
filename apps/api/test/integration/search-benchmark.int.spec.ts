import { generateCatalog } from '@agentbazaar/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsService, PgAnalyticsStore } from '../../src/modules/analytics/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { InventoryService } from '../../src/modules/inventory/index.js';
import { SearchIndexer } from '../../src/modules/search/application/search-indexer.js';
import { SearchService } from '../../src/modules/search/application/search.service.js';
import { HashEmbeddings } from '../../src/modules/search/domain/embeddings.js';
import { PgSearchAdapter } from '../../src/modules/search/infrastructure/pg-search.adapter.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { systemClock } from '../../src/shared/kernel/clock.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import { measureLatency } from '../support/search-workload.js';
import { createTestDb, usingRealPostgres, type TestDb } from '../support/test-db.js';

// PGlite is single-threaded WASM and much slower, so the latency budget is only asserted on real Postgres.
describe.skipIf(!usingRealPostgres())('@lite search latency with 10,000 products (real Postgres)', () => {
  let t: TestDb;
  let service: SearchService;

  beforeAll(async () => {
    t = await createTestDb({ poolMax: 4 });
    const db = t.database.db;
    const catalog = new CatalogService(db, new InventoryService(db, systemClock));
    await inTransaction(db, (tx) => catalog.importSeed(tx, generateCatalog({ products: 10_000 }), new Map()));
    const embeddings = new HashEmbeddings();
    const adapter = new PgSearchAdapter(db, embeddings);
    expect(await new SearchIndexer(adapter, embeddings, catalog).reindexAll()).toBe(10_000);
    // Steady state, as in production: hint bits set, visibility map and statistics current.
    await t.database.query('VACUUM ANALYZE search_documents');
    service = new SearchService(adapter, new AnalyticsService(db, new PgAnalyticsStore(db)), db, createLogger('silent'));
  }, 600_000);
  afterAll(async () => t.cleanup());

  // Retried because a busy shared machine can stall a few queries; each attempt is a full, honest run.
  it('answers 100 mixed queries with p95 under 150 ms', { retry: 2, timeout: 120_000 }, async () => {
    const { p50, p95, max } = await measureLatency(service);
    console.warn(`search latency over 100 queries, 10k products: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
    expect(p95).toBeLessThan(150);
  });
});
