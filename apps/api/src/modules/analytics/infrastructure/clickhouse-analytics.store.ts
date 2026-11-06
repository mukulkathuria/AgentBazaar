import { fileURLToPath } from 'node:url';
import type { Executor } from '../../../shared/db/database.js';
import { loadMigrations } from '../../../shared/db/migrator.js';
import { appendEvent, type OutboxEvent, type Subscription } from '../../../shared/outbox/outbox.js';
import type { AnalyticsRecord, AnalyticsStore, GeoStats, SearchStats } from '../application/ports.js';
import type { EventValue } from '../domain/sanitize.js';
import { migrateClickHouse, type ClickHouseHttp } from './clickhouse.js';

export const CLICKHOUSE_MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations/clickhouse', import.meta.url));
export const ANALYTICS_TOPIC = 'analytics.recorded';

const WINDOW = 'at > now64(3) - INTERVAL 30 DAY';

/** Postgres's `data->>'key'` for flat event data: strings as they are, numbers and booleans as text, nulls absent. */
export const toTextMap = (data: Readonly<Record<string, EventValue>>): Record<string, string> =>
  Object.fromEntries(Object.entries(data).flatMap(([k, v]) => (v === null ? [] : [[k, String(v)]])));

/** The analytics_events row for one outbox event; `at` in ClickHouse's DateTime64 text form, UTC. */
export function toRow(event: OutboxEvent) {
  const p = event.payload as Partial<AnalyticsRecord>;
  const at = event.createdAt.toISOString().replace('T', ' ').replace('Z', '');
  return { id: event.id, kind: String(p.kind), ref: p.ref ?? null, data: toTextMap(p.data ?? {}), at };
}

/**
 * Growth/scale analytics in ClickHouse. `record` only appends to the outbox inside the caller's transaction;
 * the `analytics-clickhouse` consumer then inserts each event with its outbox id as the dedupe key, so a
 * redelivered or replayed event never counts twice. Dashboards read with FINAL for exact counts.
 */
export class ClickHouseAnalyticsStore implements AnalyticsStore {
  private schema: Promise<unknown> | undefined;

  constructor(
    private readonly ch: ClickHouseHttp,
    private readonly migrationsDir = CLICKHOUSE_MIGRATIONS_DIR,
  ) {}

  async record(ex: Executor, e: AnalyticsRecord): Promise<void> {
    await appendEvent(ex, ANALYTICS_TOPIC, e.kind, { kind: e.kind, ref: e.ref, data: e.data });
  }

  subscription(): Subscription {
    return { consumer: 'analytics-clickhouse', topics: [ANALYTICS_TOPIC], handler: (event) => this.write(event) };
  }

  /** Inserts one outbox event. Safe to repeat: the event id deduplicates it. */
  async write(event: OutboxEvent): Promise<void> {
    await this.ensureSchema();
    await this.ch.insert('analytics_events', [toRow(event)], event.id);
  }

  async geo(): Promise<GeoStats> {
    await this.ensureSchema();
    const r = await this.ch.query<{ kind: string; agent: string; n: string }>(
      `SELECT kind, if(mapContains(data, 'agent'), data['agent'], 'unknown') AS agent, count() AS n FROM analytics_events FINAL
       WHERE kind IN ('crawler_hit', 'ai_referral') AND ${WINDOW} GROUP BY kind, agent`,
    );
    const geo: GeoStats = { crawlerHits: {}, aiReferrals: {} };
    for (const x of r) (x.kind === 'crawler_hit' ? geo.crawlerHits : geo.aiReferrals)[x.agent] = Number(x.n);
    return geo;
  }

  async search(): Promise<SearchStats> {
    await this.ensureSchema();
    const [totals] = await this.ch.query<{ searches: string; zero: string }>(
      `SELECT countIf(kind = 'search') AS searches, countIf(kind = 'zero_result_search') AS zero FROM analytics_events FINAL
       WHERE kind IN ('search', 'zero_result_search') AND ${WINDOW}`,
    );
    const top = await this.ch.query<{ query: string; count: string }>(
      `SELECT lowerUTF8(data['q']) AS query, count() AS count FROM analytics_events FINAL
       WHERE kind = 'zero_result_search' AND ${WINDOW} AND mapContains(data, 'q')
       GROUP BY query ORDER BY count DESC, query LIMIT 10`,
    );
    return {
      searches: Number(totals?.searches ?? 0),
      zeroResults: Number(totals?.zero ?? 0),
      topZeroResultQueries: top.map((t) => ({ query: t.query, count: Number(t.count) })),
    };
  }

  /** Applied once, lazily (like the search engines' settings); a failure is retried on the next call. */
  private ensureSchema(): Promise<unknown> {
    this.schema ??= migrateClickHouse(this.ch, loadMigrations(this.migrationsDir)).catch((err: unknown) => {
      this.schema = undefined;
      throw err;
    });
    return this.schema;
  }
}
