import { sql } from 'drizzle-orm';
import { one } from '../db/database.js';
import type { Job } from '../jobs/scheduler.js';

/** The append-only event logs that migration 0051 partitions by UTC month (ADR 0013). */
export const PARTITIONED_TABLES = [
  'order_events',
  'outbox_events',
  'processed_events',
  'webhook_events',
  'analytics_events',
  'audit_log',
  'llm_traces',
] as const;

/** Empty partitions kept ahead of now, so a few missed job runs never send rows to the default partition. */
export const MONTHS_AHEAD = 3;

/** Creates next months' partitions and moves rows that reached a default partition into their own month's partition. */
export const partitionMaintenanceJob: Job = {
  name: 'db.partition-maintenance',
  everyMs: 3600_000,
  async run(tx) {
    // Creating a partition locks its parent; give up quickly behind a long query and retry next hour.
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    let created = 0;
    for (const table of PARTITIONED_TABLES) {
      const r = await one<{ n: number }>(tx, sql`SELECT ensure_month_partitions(${table}::regclass, ${MONTHS_AHEAD}) AS n`);
      created += r?.n ?? 0;
    }
    return created;
  },
};
