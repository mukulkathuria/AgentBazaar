import { Inject, Injectable } from '@nestjs/common';
import type { TrackEventInput } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { one, rows, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import { DB } from '../../../shared/kernel/tokens.js';
import { redact } from '../../../shared/observability/redact.js';
import type { Subscription } from '../../../shared/outbox/outbox.js';
import { cleanPath, sanitizeEventData } from '../domain/sanitize.js';

export type TrackEvent = z.infer<typeof TrackEventInput>;

/** GEO numbers for the admin dashboard: AI crawler hits per bot and AI referrals per source. */
export interface GeoStats {
  crawlerHits: Record<string, number>;
  aiReferrals: Record<string, number>;
}

export interface SearchStats {
  searches: number;
  zeroResults: number;
  topZeroResultQueries: { query: string; count: number }[];
}

const WINDOW = sql`now() - interval '30 days'`;

@Injectable()
export class AnalyticsService {
  constructor(@Inject(DB) private readonly db: Executor) {}

  /** Records one event. Never pass personal data; strings are redacted and truncated regardless. */
  async track(ex: Executor, kind: string, ref: string | null, data: Readonly<Record<string, unknown>> = {}): Promise<void> {
    await ex.execute(
      sql`INSERT INTO analytics_events (kind, ref, data)
          VALUES (${kind}, ${ref === null ? null : redact(ref).slice(0, 200)}, ${json(sanitizeEventData(data))})`,
    );
  }

  /** Crawler hits, AI referrals and page views reported by the web server. */
  async ingest(event: TrackEvent): Promise<void> {
    await this.track(this.db, event.kind, cleanPath(event.path), event.agent ? { agent: event.agent } : {});
  }

  /** Last 30 days. */
  async dashboardGeo(): Promise<GeoStats> {
    const r = await rows<{ kind: string; agent: string; n: number }>(
      this.db,
      sql`SELECT kind, coalesce(data->>'agent', 'unknown') AS agent, count(*)::int AS n FROM analytics_events
          WHERE kind IN ('crawler_hit', 'ai_referral') AND at > ${WINDOW} GROUP BY 1, 2`,
    );
    const geo: GeoStats = { crawlerHits: {}, aiReferrals: {} };
    for (const x of r) (x.kind === 'crawler_hit' ? geo.crawlerHits : geo.aiReferrals)[x.agent] = x.n;
    return geo;
  }

  /** Last 30 days: how often search came back empty, and for which queries. */
  async searchStats(): Promise<SearchStats> {
    const totals = await one<{ searches: number; zero: number }>(
      this.db,
      sql`SELECT count(*) FILTER (WHERE kind = 'search')::int AS searches, count(*) FILTER (WHERE kind = 'zero_result_search')::int AS zero
          FROM analytics_events WHERE kind IN ('search', 'zero_result_search') AND at > ${WINDOW}`,
    );
    const top = await rows<{ query: string; count: number }>(
      this.db,
      sql`SELECT lower(data->>'q') AS query, count(*)::int AS count FROM analytics_events
          WHERE kind = 'zero_result_search' AND at > ${WINDOW} AND data->>'q' IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
    );
    return { searches: totals?.searches ?? 0, zeroResults: totals?.zero ?? 0, topZeroResultQueries: top };
  }

  /** Consumer for `negotiation.closed`: outcome, band and discount only, never the parties. */
  negotiationSubscription(): Subscription {
    return {
      consumer: 'analytics-negotiations',
      topics: ['negotiation.closed'],
      handler: async (event, tx) => {
        const { negotiationId, outcome, band, discountBps } = event.payload;
        const ref = typeof negotiationId === 'string' ? negotiationId : event.aggregateId;
        await this.track(tx, 'negotiation_outcome', ref, { outcome, band, discountBps });
      },
    };
  }
}
