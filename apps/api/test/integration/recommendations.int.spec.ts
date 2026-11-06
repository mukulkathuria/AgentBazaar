import { randomUUID } from 'node:crypto';
import { Module, type Type } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@agentbazaar/config';
import { ProductSummary } from '@agentbazaar/contracts';
import { generateCatalog, type SeedCatalog } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInfra, type Infra } from '../../src/bootstrap/infra.js';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { InventoryService } from '../../src/modules/inventory/index.js';
import {
  GRAPH_REPOSITORY,
  RecommendationsModule,
  RecommendationsService,
  type GraphRepository,
} from '../../src/modules/recommendations/index.js';
import { installPropertyGraph } from '../../src/modules/recommendations/infrastructure/pgq-graph.repository.js';
import { inTransaction, one, rows } from '../../src/shared/db/database.js';
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

const GPU = 'zentrix-zx7070-12gb';
const neighbours = (seed: SeedCatalog, slug: string, kind: string) =>
  seed.edges.filter((e) => e.kind === kind && (e.from === slug || e.to === slug)).map((e) => (e.from === slug ? e.to : e.from));

describe('@lite recommendations module (graph, learner, REST)', () => {
  let ctx: Awaited<ReturnType<typeof bootModules>>;
  let recs: RecommendationsService;
  let seed: SeedCatalog;
  let ids: Map<string, string>;

  const weightBetween = async (a: string, b: string) =>
    (
      await one<{ w: number }>(
        ctx.infra.db,
        sql`SELECT coalesce(sum(weight), 0)::float8 AS w FROM product_edges
            WHERE kind = 'bought_together' AND ((a_id = ${a} AND b_id = ${b}) OR (a_id = ${b} AND b_id = ${a}))`,
      )
    )!.w;

  beforeAll(async () => {
    ctx = await bootModules([RecommendationsModule]);
    recs = ctx.app.get(RecommendationsService);
    seed = generateCatalog({ products: 300 });
    const catalog = ctx.app.get(CatalogService);
    await inTransaction(ctx.infra.db, async (tx) => {
      ids = await catalog.importSeed(tx, seed, new Map());
      expect(await recs.importEdges(tx, seed.edges, ids)).toBe(seed.edges.length);
    });
  }, 120_000);
  afterAll(async () => ctx.close());

  it('falls back to plain SQL joins below PostgreSQL 19', async () => {
    expect(await installPropertyGraph(ctx.infra.db)).toBe(false);
    expect(ctx.app.get<GraphRepository>(GRAPH_REPOSITORY).engine).toBe('sql');
  });

  it('imports seed edges idempotently and skips unknown products', async () => {
    const extra = [{ from: GPU, to: 'no-such-product', kind: 'compatible_with' as const, rule: null, weight: 1 }];
    await inTransaction(ctx.infra.db, async (tx) => expect(await recs.importEdges(tx, [...seed.edges, ...extra], ids)).toBe(0));
  });

  it('lists the PSUs and cases that fit a GPU, by slug or SKU', async () => {
    const expected = neighbours(seed, GPU, 'compatible_with');
    expect(expected.length).toBeGreaterThan(0);
    const bySlug = await recs.compatible(GPU);
    expect(new Set(bySlug.map((p) => p.slug))).toEqual(new Set(expected));
    expect(new Set(bySlug.map((p) => p.categoryPath))).toEqual(new Set(['electronics.components.psus', 'electronics.components.cases']));
    expect((await recs.compatible('ZENTRIX-ZX7070-12G')).map((p) => p.slug)).toEqual(bySlug.map((p) => p.slug));
  });

  it('reads compatibility in both directions: a PSU lists the GPUs it can power', async () => {
    const typeOf = new Map(seed.products.map((p) => [p.slug, p.productType]));
    const psu = neighbours(seed, GPU, 'compatible_with').find((s) => typeOf.get(s) === 'psu')!;
    const gpus = new Set(neighbours(seed, psu, 'compatible_with'));
    const r = await recs.compatible(psu, 5);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => gpus.has(p.slug) && p.categoryPath === 'electronics.components.gpus')).toBe(true);
  });

  it('puts in-stock items first', async () => {
    const before = await recs.compatible(GPU);
    const target = before[0]!;
    const variants = await rows<{ id: string }>(ctx.infra.db, sql`SELECT id FROM variants WHERE product_id = ${target.id}`);
    const inventory = ctx.app.get(InventoryService);
    await inTransaction(ctx.infra.db, async (tx) => {
      for (const v of variants) await inventory.setStock(tx, v.id, 0);
    });
    const after = await recs.compatible(GPU);
    const firstOut = after.findIndex((p) => !p.inStock);
    expect(after.slice(firstOut).every((p) => !p.inStock)).toBe(true);
    expect(after.find((p) => p.id === target.id)?.inStock).toBe(false);
    expect(after.findIndex((p) => p.id === target.id)).toBeGreaterThanOrEqual(firstOut);
  });

  it('recommends bought-together items before alternatives', async () => {
    const together = neighbours(seed, GPU, 'bought_together');
    const alternatives = neighbours(seed, GPU, 'alternative_of');
    expect(together.length).toBeGreaterThan(0);
    const r = (await recs.recommendations(GPU)).map((p) => p.slug);
    expect(new Set(r.slice(0, together.length))).toEqual(new Set(together));
    expect(r.slice(together.length).every((s) => alternatives.includes(s))).toBe(true);
    expect(r).not.toContain(GPU);
  });

  it('learns bought-together weights from paid orders', async () => {
    const typeOf = new Map(seed.products.map((p) => [p.slug, p.productType]));
    const edge = seed.edges.find((e) => e.kind === 'bought_together' && typeOf.get(e.from) === 'keyboard')!;
    const [k, m] = [ids.get(edge.from)!, ids.get(edge.to)!];
    const t = ids.get(seed.products.find((p) => p.productType === 'tea')!.slug)!;
    const [km, kt, mt] = [await weightBetween(k, m), await weightBetween(k, t), await weightBetween(m, t)];
    expect(km).toBeCloseTo(edge.weight);
    expect(kt).toBe(0);

    const orderPaid = (productIds: unknown[]) => {
      const orderId = randomUUID();
      return appendEvent(ctx.infra.db, 'order.paid', orderId, { orderId, productIds });
    };
    await orderPaid([k, m, t, k, 'not-a-uuid', 7]);
    await orderPaid([m, k]);
    await ctx.drain();

    expect(await weightBetween(k, m)).toBeCloseTo(km + 2);
    expect(await weightBetween(k, t)).toBe(1);
    expect(await weightBetween(m, t)).toBeCloseTo(mt + 1);
    const top = await recs.recommendations(edge.from, 1);
    expect(top.map((p) => p.slug)).toEqual([edge.to]);
  });

  it('serves the REST endpoints and 404s unknown products', async () => {
    for (const path of ['compatible', 'recommendations']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/products/${GPU}/${path}` });
      expect(res.statusCode).toBe(200);
      expect(z.array(ProductSummary).parse(res.json()).length).toBeGreaterThan(0);
    }
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/products/no-such-product/compatible' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
