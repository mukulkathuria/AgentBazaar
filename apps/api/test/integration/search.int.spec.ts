import { Module, type Type } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@agentbazaar/config';
import { AdminProductInput, SearchResult } from '@agentbazaar/contracts';
import { generateCatalog } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfra, type Infra } from '../../src/bootstrap/infra.js';
import { AnalyticsService } from '../../src/modules/analytics/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { InventoryService } from '../../src/modules/inventory/index.js';
import { SEARCH_PORT, SearchIndexer, SearchModule, SearchService, type SearchPort } from '../../src/modules/search/index.js';
import { PgSearchAdapter } from '../../src/modules/search/infrastructure/pg-search.adapter.js';
import { inTransaction, one } from '../../src/shared/db/database.js';
import { AuthGuard, TOKEN_VERIFIER } from '../../src/shared/http/auth.js';
import { ErrorFilter } from '../../src/shared/http/error.filter.js';
import { InfraModule } from '../../src/shared/infra.module.js';
import { AppError } from '../../src/shared/kernel/errors.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import { appendEvent } from '../../src/shared/outbox/outbox.js';
import { createTestDb } from '../support/test-db.js';

/** The real app's wiring (infra, auth guard, error envelope) around just the modules under test. */
async function bootModules(modules: Type[], env: Record<string, string> = {}) {
  // Few connections: on Windows each Postgres backend is a new process (~200 ms), so pools fill slowly.
  const testDb = await createTestDb({ poolMax: 4 });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_DRIVER: testDb.url ? 'postgres' : 'pglite',
    ...(testDb.url ? { DATABASE_URL: testDb.url } : {}),
    RATE_LIMIT_PER_MINUTE: '100000',
    ...env,
  });
  const infra: Infra = await createInfra(config, { database: testDb.database, logger: createLogger('silent') });
  // Every route under test is public, so bearer tokens are simply rejected instead of wiring identity.
  const verifier = { verify: () => Promise.reject(new AppError('unauthorized', 'No tokens in this test')) };
  @Module({
    imports: [InfraModule.register(infra), ...modules],
    providers: [{ provide: TOKEN_VERIFIER, useValue: verifier }, { provide: APP_GUARD, useClass: AuthGuard }],
  })
  class TestApiModule {}
  const app = await NestFactory.create<NestFastifyApplication>(TestApiModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new ErrorFilter(infra.logger));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, infra, drain: () => infra.relay.drain(), close: async () => (await app.close(), await testDb.cleanup()) };
}

describe('@lite search module (indexer, service, REST)', () => {
  let ctx: Awaited<ReturnType<typeof bootModules>>;
  let search: SearchService;
  let catalog: CatalogService;

  beforeAll(async () => {
    ctx = await bootModules([SearchModule]);
    catalog = ctx.app.get(CatalogService);
    search = ctx.app.get(SearchService);
    await inTransaction(ctx.infra.db, (tx) => catalog.importSeed(tx, generateCatalog({ products: 150 }), new Map()));
  }, 120_000);
  afterAll(async () => ctx.close());

  it('selects the Postgres adapter for the lite profile and reindexes every active product', async () => {
    const port = ctx.app.get<SearchPort>(SEARCH_PORT);
    expect(port).toBeInstanceOf(PgSearchAdapter);
    expect(await ctx.app.get(SearchIndexer).reindexAll(40)).toBe(150);
    expect(await port.count()).toBe(150);
  });

  it('indexes new products and stock changes from the outbox', async () => {
    expect((await search.search({ q: 'zorbex' })).total).toBe(0);
    await catalog.upsertProduct(
      AdminProductInput.parse({
        slug: 'zorbex-quantum-mug',
        name: 'Zorbex Quantum Mug',
        brand: 'Zorbex',
        description: 'A heat-changing ceramic mug.',
        categoryPath: 'home.mugs',
        hsnCode: '6912',
        variants: [{ sku: 'ZORBEX-QMUG', title: 'Standard', pricePaise: 59_900, mrpPaise: 69_900, costPricePaise: 30_000, stock: 5 }],
      }),
      'admin:test',
    );
    await ctx.drain();
    const found = await search.search({ q: 'zorbex quantum' });
    expect(found.items[0]).toMatchObject({ slug: 'zorbex-quantum-mug', inStock: true, minPricePaise: 59_900, defaultSku: 'ZORBEX-QMUG' });

    const variant = (await catalog.findVariant('ZORBEX-QMUG'))!;
    await inTransaction(ctx.infra.db, (tx) => ctx.app.get(InventoryService).setStock(tx, variant.variantId, 0));
    await ctx.drain();
    expect((await search.search({ q: 'zorbex' })).items[0]?.inStock).toBe(false);
    expect((await search.search({ q: 'zorbex', inStockOnly: true })).total).toBe(0);
  });

  it('drops products that are no longer active and ignores malformed payloads', async () => {
    const { id } = (await one<{ id: string }>(ctx.infra.db, sql`SELECT id FROM products WHERE slug = 'zorbex-quantum-mug'`))!;
    await inTransaction(ctx.infra.db, async (tx) => {
      await tx.execute(sql`UPDATE products SET status = 'archived' WHERE id = ${id}`);
      await appendEvent(tx, 'catalog.product_upserted', id, { productId: id });
      await appendEvent(tx, 'catalog.product_upserted', 'x', { productId: 'not-a-uuid' });
      await appendEvent(tx, 'inventory.stock_changed', 'x', { variantId: 42 });
    });
    await ctx.drain();
    expect((await search.search({ q: 'zorbex' })).total).toBe(0);
    const pending = await one<{ n: number }>(ctx.infra.db, sql`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
    expect(pending!.n).toBe(0);
  });

  it('records searches and redacted zero-result queries', async () => {
    await search.search({ q: 'mug' });
    await search.search({ q: 'Glitter unicorn for priya@example.com' });
    await search.search({ q: 'glitter unicorn for priya@example.com' });
    const stats = await ctx.app.get(AnalyticsService).searchStats();
    expect(stats.searches).toBeGreaterThanOrEqual(3);
    expect(stats.topZeroResultQueries).toContainEqual({ query: 'glitter unicorn for [email]', count: 2 });
  });

  it('serves GET /api/v1/products per the contract', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/products?q=keyboard&limit=3&inStockOnly=true' });
    expect(res.statusCode).toBe(200);
    const body = SearchResult.parse(res.json());
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThanOrEqual(3);
    expect(body.items.every((i) => i.inStock)).toBe(true);
    const bad = await ctx.app.inject({ method: 'GET', url: '/api/v1/products?limit=500' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });
});
