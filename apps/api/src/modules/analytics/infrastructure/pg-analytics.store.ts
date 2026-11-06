import { sql } from 'drizzle-orm';
import { one, rows, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import type { AnalyticsRecord, AnalyticsStore, GeoStats, SearchStats } from '../application/ports.js';

const WINDOW = sql`now() - interval '30 days'`;

/** Every profile's default: the `analytics_events` table, written in the caller's transaction. */
export class PgAnalyticsStore implements AnalyticsStore {
  /** `reads` serves the dashboard aggregates only: a replica in growth. */
  constructor(private readonly reads: Executor) {}

  async record(ex: Executor, e: AnalyticsRecord): Promise<void> {
    await ex.execute(sql`INSERT INTO analytics_events (kind, ref, data) VALUES (${e.kind}, ${e.ref}, ${json(e.data)})`);
  }

  async geo(): Promise<GeoStats> {
    const r = await rows<{ kind: string; agent: string; n: number }>(
      this.reads,
      sql`SELECT kind, coalesce(data->>'agent', 'unknown') AS agent, count(*)::int AS n FROM analytics_events
          WHERE kind IN ('crawler_hit', 'ai_referral') AND at > ${WINDOW} GROUP BY 1, 2`,
    );
    const geo: GeoStats = { crawlerHits: {}, aiReferrals: {} };
    for (const x of r) (x.kind === 'crawler_hit' ? geo.crawlerHits : geo.aiReferrals)[x.agent] = x.n;
    return geo;
  }

  async search(): Promise<SearchStats> {
    const totals = await one<{ searches: number; zero: number }>(
      this.reads,
      sql`SELECT count(*) FILTER (WHERE kind = 'search')::int AS searches, count(*) FILTER (WHERE kind = 'zero_result_search')::int AS zero
          FROM analytics_events WHERE kind IN ('search', 'zero_result_search') AND at > ${WINDOW}`,
    );
    // Ties break in byte order (COLLATE "C"), as ClickHouse sorts strings, so both stores rank alike.
    const top = await rows<{ query: string; count: number }>(
      this.reads,
      sql`SELECT lower(data->>'q') AS query, count(*)::int AS count FROM analytics_events
          WHERE kind = 'zero_result_search' AND at > ${WINDOW} AND data->>'q' IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC, lower(data->>'q') COLLATE "C" LIMIT 10`,
    );
    return { searches: totals?.searches ?? 0, zeroResults: totals?.zero ?? 0, topZeroResultQueries: top };
  }
}
