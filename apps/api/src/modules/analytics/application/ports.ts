import type { Executor } from '../../../shared/db/database.js';
import type { Subscription } from '../../../shared/outbox/outbox.js';
import type { EventValue } from '../domain/sanitize.js';

/** One event after redaction and sanitizing, as every store receives it. */
export interface AnalyticsRecord {
  kind: string;
  ref: string | null;
  data: Record<string, EventValue>;
}

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

/**
 * Analytics store, chosen by `config.adapters.analytics`: Postgres `analytics_events` (default) or ClickHouse,
 * fed from the outbox. Dashboards cover the last 30 days and give the same answers for the same events.
 */
export interface AnalyticsStore {
  /** Writes inside the caller's transaction (Postgres) or appends to its outbox (ClickHouse). */
  record(ex: Executor, event: AnalyticsRecord): Promise<void>;
  geo(): Promise<GeoStats>;
  search(): Promise<SearchStats>;
  /** The outbox consumer that feeds a store living outside Postgres. */
  subscription?(): Subscription;
}

export const ANALYTICS_STORE = Symbol('ANALYTICS_STORE');
