import { sql } from 'drizzle-orm';
import { one, type Executor } from '../../../shared/db/database.js';

/** Money is in: an online order once its payment settled, a cash-on-delivery order once delivered. */
const MONEY_IN = sql`(status IN ('paid', 'delivered', 'return_requested') OR (status = 'shipped' AND payment_method = 'online'))`;

/** Admin dashboard: orders placed in the last 30 days, how many are paid, and what they brought in. */
export async function orderStats(ex: Executor): Promise<{ total: number; paid: number; revenuePaise: number }> {
  const r = await one<{ total: number; paid: number; revenue: string }>(
    ex,
    sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE ${MONEY_IN})::int AS paid,
               coalesce(sum(total_paise) FILTER (WHERE ${MONEY_IN}), 0)::text AS revenue
        FROM orders WHERE created_at > now() - interval '30 days'`,
  );
  return { total: r?.total ?? 0, paid: r?.paid ?? 0, revenuePaise: Number(r?.revenue ?? 0) };
}
