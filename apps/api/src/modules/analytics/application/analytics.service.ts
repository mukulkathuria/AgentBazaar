import { Inject, Injectable } from '@nestjs/common';
import type { TrackEventInput } from '@agentbazaar/contracts';
import type { z } from 'zod';
import type { Executor } from '../../../shared/db/database.js';
import { DB } from '../../../shared/kernel/tokens.js';
import { redact } from '../../../shared/observability/redact.js';
import type { Subscription } from '../../../shared/outbox/outbox.js';
import { cleanPath, sanitizeEventData } from '../domain/sanitize.js';
import { ANALYTICS_STORE, type AnalyticsStore, type GeoStats, type SearchStats } from './ports.js';

export type TrackEvent = z.infer<typeof TrackEventInput>;

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(ANALYTICS_STORE) private readonly store: AnalyticsStore,
  ) {}

  /** Records one event. Never pass personal data; strings are redacted and truncated regardless. */
  async track(ex: Executor, kind: string, ref: string | null, data: Readonly<Record<string, unknown>> = {}): Promise<void> {
    await this.store.record(ex, { kind, ref: ref === null ? null : redact(ref).slice(0, 200), data: sanitizeEventData(data) });
  }

  /** Crawler hits, AI referrals and page views reported by the web server. */
  async ingest(event: TrackEvent): Promise<void> {
    await this.track(this.db, event.kind, cleanPath(event.path), event.agent ? { agent: event.agent } : {});
  }

  /** Last 30 days. */
  dashboardGeo(): Promise<GeoStats> {
    return this.store.geo();
  }

  /** Last 30 days: how often search came back empty, and for which queries. */
  searchStats(): Promise<SearchStats> {
    return this.store.search();
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
