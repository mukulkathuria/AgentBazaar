import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsService, PgAnalyticsStore } from '../../src/modules/analytics/index.js';
import {
  ANALYTICS_TOPIC,
  CLICKHOUSE_MIGRATIONS_DIR,
  ClickHouseAnalyticsStore,
  toRow,
} from '../../src/modules/analytics/infrastructure/clickhouse-analytics.store.js';
import { ClickHouseHttp, migrateClickHouse } from '../../src/modules/analytics/infrastructure/clickhouse.js';
import { rows } from '../../src/shared/db/database.js';
import { loadMigrations } from '../../src/shared/db/migrator.js';
import type { OutboxEvent } from '../../src/shared/outbox/outbox.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

// The same events go to Postgres (analytics_events) and, through the outbox, to ClickHouse.
const EVENTS: [kind: string, ref: string | null, data: Record<string, unknown>][] = [
  ['crawler_hit', '/', { agent: 'GPTBot' }],
  ['crawler_hit', '/products/thock-tk87', { agent: 'GPTBot' }],
  ['crawler_hit', '/', { agent: 'ClaudeBot' }],
  ['crawler_hit', '/', {}],
  ['crawler_hit', '/', { agent: null }],
  ['crawler_hit', '/', { agent: '' }],
  ['ai_referral', '/', { agent: 'chatgpt.com' }],
  ['ai_referral', '/', { agent: 'chatgpt.com' }],
  ['ai_referral', '/', { agent: 'perplexity.ai' }],
  ['search', null, { q: 'tea', total: 4 }],
  ['search', null, { q: 'mug', total: 2 }],
  ['zero_result_search', null, { q: 'Kettle' }],
  ['zero_result_search', null, { q: 'kettle' }],
  ['zero_result_search', null, { q: 'KETTLE' }],
  ['zero_result_search', null, { q: 'Café Filtre' }],
  ['zero_result_search', null, { q: 'café filtre' }],
  ['zero_result_search', null, { q: 'मसाला चाय' }],
  ['zero_result_search', null, { q: 'samovar' }],
  ['zero_result_search', null, { q: 'a b' }],
  ['zero_result_search', null, { q: 'ab' }],
  ['zero_result_search', null, { q: 'Zebra' }],
  ['zero_result_search', null, {}],
  ['page_view', '/account/priya@example.com', {}],
  ['negotiation_outcome', 'n-1', { outcome: 'accepted', band: 'standard', discountBps: 520 }],
];

const MONTH_MS = 30 * 24 * 3600 * 1000;
const event = (kind: string, data: Record<string, unknown>, ageMs: number): OutboxEvent => ({
  id: randomUUID(),
  topic: ANALYTICS_TOPIC,
  aggregateId: kind,
  payload: { kind, ref: '/', data },
  createdAt: new Date(Date.now() - ageMs),
});

describe('@scale ClickHouse analytics (outbox consumer, dashboards, migrations)', () => {
  const admin = new ClickHouseHttp(process.env.CLICKHOUSE_URL!);
  const database = `t10_analytics_${randomBytes(4).toString('hex')}`;
  const url = new URL(process.env.CLICKHOUSE_URL!);
  url.pathname = `/${database}`;
  const ch = new ClickHouseHttp(url.toString());
  const store = new ClickHouseAnalyticsStore(ch);
  let app: TestApp;
  let pg: AnalyticsService;
  let viaClickHouse: AnalyticsService;

  const count = async (final: boolean) =>
    Number((await ch.query<{ n: string }>(`SELECT count() AS n FROM analytics_events${final ? ' FINAL' : ''}`))[0]!.n);
  const analyticsEvents = async (): Promise<OutboxEvent[]> =>
    (
      await rows<{ id: string; aggregate_id: string; payload: Record<string, unknown>; created_at: Date }>(
        app.infra.db,
        sql`SELECT id, aggregate_id, payload, created_at FROM outbox_events WHERE topic = ${ANALYTICS_TOPIC} ORDER BY created_at, id`,
      )
    ).map((r) => ({ id: r.id, topic: ANALYTICS_TOPIC, aggregateId: r.aggregate_id, payload: r.payload, createdAt: r.created_at }));

  beforeAll(async () => {
    await admin.exec(`CREATE DATABASE IF NOT EXISTS ${database}`);
    app = await createTestApp({ ANALYTICS_ADAPTER: 'clickhouse', CLICKHOUSE_URL: url.toString() });
    viaClickHouse = app.app.get(AnalyticsService);
    pg = new AnalyticsService(app.infra.db, new PgAnalyticsStore(app.infra.db));
    for (const [kind, ref, data] of EVENTS) {
      await pg.track(app.infra.db, kind, ref, data);
      await viaClickHouse.track(app.infra.db, kind, ref, data);
    }
    await app.drain();
    // Outside the 30-day window in both stores.
    await app.infra.db.execute(sql`INSERT INTO analytics_events (kind, data, at) VALUES ('crawler_hit', '{"agent":"GPTBot"}', now() - interval '31 days')`);
    await app.infra.db.execute(sql`INSERT INTO analytics_events (kind, data, at) VALUES ('zero_result_search', '{"q":"kettle"}', now() - interval '31 days')`);
    await store.write(event('crawler_hit', { agent: 'GPTBot' }, 31 * 24 * 3600 * 1000));
    await store.write(event('zero_result_search', { q: 'kettle' }, 31 * 24 * 3600 * 1000));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await admin.exec(`DROP DATABASE IF EXISTS ${database}`);
  });

  it('writes every tracked event through the outbox consumer', async () => {
    expect((await analyticsEvents()).length).toBe(EVENTS.length);
    expect(await count(true)).toBe(EVENTS.length + 2);
    const [pageView] = await ch.query<{ ref: string; data: Record<string, string> }>(`SELECT ref, data FROM analytics_events WHERE kind = 'page_view'`);
    expect(pageView).toEqual({ ref: '/account/[EMAIL]', data: {} });
  });

  it('serves the GEO dashboard with the same numbers as Postgres', async () => {
    const geo = await viaClickHouse.dashboardGeo();
    expect(geo).toEqual(await pg.dashboardGeo());
    expect(geo).toEqual({
      crawlerHits: { GPTBot: 2, ClaudeBot: 1, unknown: 2, '': 1 },
      aiReferrals: { 'chatgpt.com': 2, 'perplexity.ai': 1 },
    });
  });

  it('serves search stats with the same numbers and ranking as Postgres', async () => {
    const stats = await viaClickHouse.searchStats();
    expect(stats).toEqual(await pg.searchStats());
    expect(stats.searches).toBe(2);
    expect(stats.zeroResults).toBe(11);
    expect(stats.topZeroResultQueries.slice(0, 2)).toEqual([
      { query: 'kettle', count: 3 },
      { query: 'café filtre', count: 2 },
    ]);
  });

  it('counts a replayed event once: redelivery after a crash, and a replay past the dedup window', async () => {
    const before = { geo: await viaClickHouse.dashboardGeo(), search: await viaClickHouse.searchStats(), raw: await count(false) };
    const delivered = await analyticsEvents();

    // The consumer crashed after inserting but before committing: every event is delivered again.
    await app.infra.db.execute(sql`DELETE FROM processed_events WHERE consumer = 'analytics-clickhouse'`);
    await app.infra.db.execute(sql`UPDATE outbox_events SET published_at = NULL, next_attempt_at = now() WHERE topic = ${ANALYTICS_TOPIC}`);
    expect(await app.drain()).toBe(delivered.length);
    expect(await count(false)).toBe(before.raw); // insert deduplication skipped every repeat

    // Older than the deduplication window: the rows land, then ReplacingMergeTree collapses them. Background
    // merges are paused while the copies are counted, or a merge may already have collapsed some of them.
    await ch.exec('SYSTEM STOP MERGES analytics_events');
    try {
      for (const e of delivered.slice(0, 5)) await ch.insert('analytics_events', [toRow(e)], `${e.id}-late`);
      expect(await count(false)).toBe(before.raw + 5);
      expect(await viaClickHouse.dashboardGeo()).toEqual(before.geo);
      expect(await viaClickHouse.searchStats()).toEqual(before.search);
    } finally {
      await ch.exec('SYSTEM START MERGES analytics_events');
    }
    await ch.exec('OPTIMIZE TABLE analytics_events FINAL');
    expect(await count(false)).toBe(before.raw);
  });

  it('creates monthly partitions with a TTL through the ClickHouse migration runner', async () => {
    const [table] = await ch.query<{ engine: string; partition_key: string; sorting_key: string; create_table_query: string }>(
      `SELECT engine, partition_key, sorting_key, create_table_query FROM system.tables WHERE database = {db:String} AND name = 'analytics_events'`,
      { db: database },
    );
    expect(table).toMatchObject({ engine: 'ReplacingMergeTree', partition_key: 'toYYYYMM(at)', sorting_key: 'kind, at, id' });
    expect(table!.create_table_query).toContain('TTL toDateTime(at) + toIntervalMonth(13)');
    const partitions = await ch.query<{ partition: string }>(
      `SELECT DISTINCT partition FROM system.parts WHERE database = {db:String} AND table = 'analytics_events' AND active`,
      { db: database },
    );
    expect(partitions.length).toBeGreaterThanOrEqual(2);
    expect(await ch.query(`SELECT version FROM schema_migrations FINAL`)).toEqual([{ version: '0065' }]);
    expect(await migrateClickHouse(ch, loadMigrations(CLICKHOUSE_MIGRATIONS_DIR))).toEqual([]);
  });

  it('drops events older than the 13-month TTL', async () => {
    const stale = event('crawler_hit', { agent: 'OldBot' }, 14 * MONTH_MS);
    await store.write(stale);
    await ch.exec('OPTIMIZE TABLE analytics_events FINAL');
    expect(await ch.query(`SELECT id FROM analytics_events WHERE id = {id:UUID}`, { id: stale.id })).toEqual([]);
  });
});
