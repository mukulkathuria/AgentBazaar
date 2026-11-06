import { randomUUID } from 'node:crypto';
import { Module, type Type } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from '@agentbazaar/config';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfra, type Infra } from '../../src/bootstrap/infra.js';
import { AnalyticsModule, AnalyticsService } from '../../src/modules/analytics/index.js';
import { AnalyticsController } from '../../src/modules/analytics/interfaces/analytics.controller.js';
import { rows } from '../../src/shared/db/database.js';
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

const KEY = 'ingest-key-for-tests-0123456789';

describe('@lite analytics module (ingest, GEO dashboard, consumers)', () => {
  let ctx: Awaited<ReturnType<typeof bootModules>>;
  let analytics: AnalyticsService;
  const post = (payload: unknown, key?: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      headers: key === undefined ? {} : { 'x-ingest-key': key },
      payload: payload as Record<string, unknown>,
    });
  const eventsOf = (kind: string) =>
    rows<{ ref: string | null; data: Record<string, unknown> }>(ctx.infra.db, sql`SELECT ref, data FROM analytics_events WHERE kind = ${kind} ORDER BY id`);

  beforeAll(async () => {
    ctx = await bootModules([AnalyticsModule], { ANALYTICS_INGEST_KEY: KEY });
    analytics = ctx.app.get(AnalyticsService);
  }, 120_000);
  afterAll(async () => ctx.close());

  it('requires the configured ingest key before looking at the body', async () => {
    for (const key of [undefined, 'wrong-key', `${KEY}x`]) {
      const res = await post({ nonsense: true }, key);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
    expect((await post({ kind: 'bogus', path: '/' }, KEY)).statusCode).toBe(400);
    expect((await post({ kind: 'page_view', path: '/', extra: 1 }, KEY)).statusCode).toBe(400);
  });

  it('accepts crawler hits with 202 and keeps neither query strings nor personal data', async () => {
    const res = await post({ kind: 'crawler_hit', path: '/products/thock-tk87?t=secret-token&utm=x', agent: 'GPTBot' }, KEY);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    await post({ kind: 'page_view', path: '/account/priya@example.com#orders' }, KEY);
    expect(await eventsOf('crawler_hit')).toEqual([{ ref: '/products/thock-tk87', data: { agent: 'GPTBot' } }]);
    expect(await eventsOf('page_view')).toEqual([{ ref: '/account/[EMAIL]', data: {} }]);
  });

  it('summarises the last 30 days of AI crawler hits and referrals', async () => {
    const hits = [
      ['crawler_hit', 'GPTBot'],
      ['crawler_hit', 'ClaudeBot'],
      ['crawler_hit', 'PerplexityBot'],
      ['crawler_hit', 'Google-Extended'],
      ['ai_referral', 'chatgpt.com'],
      ['ai_referral', 'chatgpt.com'],
      ['ai_referral', 'perplexity.ai'],
    ];
    for (const [kind, agent] of hits) expect((await post({ kind, path: '/', agent }, KEY)).statusCode).toBe(202);
    await ctx.infra.db.execute(
      sql`INSERT INTO analytics_events (kind, data, at) VALUES ('crawler_hit', '{"agent":"GPTBot"}', now() - interval '31 days')`,
    );
    expect(await analytics.dashboardGeo()).toEqual({
      crawlerHits: { GPTBot: 2, ClaudeBot: 1, PerplexityBot: 1, 'Google-Extended': 1 },
      aiReferrals: { 'chatgpt.com': 2, 'perplexity.ai': 1 },
    });
  });

  it('accepts events without a key when none is configured', async () => {
    const config = { ...ctx.infra.config, env: { ...ctx.infra.config.env, ANALYTICS_INGEST_KEY: undefined } };
    const controller = new AnalyticsController(analytics, config);
    await expect(controller.track({ kind: 'ai_referral', path: '/', agent: 'claude.ai' }, undefined)).resolves.toEqual({ ok: true });
  });

  it('records negotiation outcomes from negotiation.closed without personal data', async () => {
    const negotiationId = randomUUID();
    await appendEvent(ctx.infra.db, 'negotiation.closed', negotiationId, {
      negotiationId,
      outcome: 'accepted',
      band: 'standard',
      discountBps: 520,
      buyer: 'priya@example.com',
    });
    await ctx.drain();
    expect(await eventsOf('negotiation_outcome')).toEqual([
      { ref: negotiationId, data: { outcome: 'accepted', band: 'standard', discountBps: 520 } },
    ]);
  });

  it('reports searches and the most common zero-result queries', async () => {
    for (const q of ['tea', 'mug', 'kettle']) await analytics.track(ctx.infra.db, 'search', null, { q, total: 1 });
    for (const q of ['Kettle', 'kettle', 'samovar']) await analytics.track(ctx.infra.db, 'zero_result_search', null, { q });
    expect(await analytics.searchStats()).toEqual({
      searches: 3,
      zeroResults: 3,
      topZeroResultQueries: [
        { query: 'kettle', count: 2 },
        { query: 'samovar', count: 1 },
      ],
    });
  });
});
