import { sql } from 'drizzle-orm';
import { one, type Executor } from '../../../shared/db/database.js';

const DEAL = sql`state IN ('accepted', 'checkout')`;
const NO_DEAL = sql`state IN ('rejected', 'expired')`;

/** Admin dashboard: negotiations started in the last 30 days, how the closed ones ended, and the average deal discount. */
export async function negotiationStats(ex: Executor) {
  const r = await one<{ total: number; accepted: number; rejected: number; discount_bps: number | null }>(
    ex,
    sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE ${DEAL})::int AS accepted,
               count(*) FILTER (WHERE ${NO_DEAL})::int AS rejected,
               (avg((list_unit_paise - final_unit_paise) * 10000.0 / nullif(list_unit_paise, 0))
                 FILTER (WHERE ${DEAL} AND final_unit_paise IS NOT NULL))::float8 AS discount_bps
        FROM negotiation_sessions WHERE created_at > now() - interval '30 days'`,
  );
  const accepted = r?.accepted ?? 0;
  const rejected = r?.rejected ?? 0;
  return {
    total: r?.total ?? 0,
    accepted,
    rejected,
    avgDiscountBps: Math.round(r?.discount_bps ?? 0),
    acceptRate: accepted + rejected > 0 ? accepted / (accepted + rejected) : 0,
  };
}

/** Discounts waiting for a human. */
export async function pendingApprovals(ex: Executor): Promise<number> {
  return (await one<{ n: number }>(ex, sql`SELECT count(*)::int AS n FROM pricing_approvals WHERE status = 'pending'`))?.n ?? 0;
}
