import { sql } from 'drizzle-orm';
import { one, type Executor } from '../../../shared/db/database.js';

/** Flagged personalisation text waiting for a human. */
export async function pendingReviews(ex: Executor): Promise<number> {
  return (await one<{ n: number }>(ex, sql`SELECT count(*)::int AS n FROM customization_reviews WHERE status = 'pending'`))?.n ?? 0;
}
