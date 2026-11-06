import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../../src/shared/db/migrator.js';
import { Scheduler } from '../../src/shared/jobs/scheduler.js';
import { runIdempotent } from '../../src/shared/outbox/outbox.js';
import { MONTHS_AHEAD, PARTITIONED_TABLES, partitionMaintenanceJob } from '../../src/shared/partitions/partitions.js';
import { createTestDb, MIGRATIONS_DIR, type TestDb } from '../support/test-db.js';

/** UTC month `offset` months from now, as YYYYMM (the partition suffix). */
const monthFromNow = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7).replace('-', '');
};

describe('@lite event logs are partitioned by UTC month', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.cleanup());
  const q = <T>(text: string, params?: unknown[]) => t.database.query<T>(text, params);

  it('gives each event log a default partition, partitions through three months ahead, and keys with the month', async () => {
    for (const table of PARTITIONED_TABLES) {
      const parts = await q<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass`,
        [table],
      );
      const expected = [`${table}_default`, ...[0, 1, 2, 3].map((o) => `${table}_p${monthFromNow(o)}`)];
      expect(parts.map((p) => p.name)).toEqual(expect.arrayContaining(expected));
      const [pk] = await q<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_partitioned_table p ON p.partrelid = c.conrelid
         JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = p.partattrs[0]
         WHERE c.conrelid = $1::regclass AND c.contype = 'p' AND pg_get_constraintdef(c.oid) LIKE '%' || a.attname || '%'`,
        [table],
      );
      expect(pk?.def, `${table} primary key includes the partition key`).toMatch(/^PRIMARY KEY/);
    }
  });

  it('moves rows that reached the default partition into their month once it is created', async () => {
    const month = monthFromNow(MONTHS_AHEAD + 2);
    await q(`INSERT INTO audit_log (actor, action, at) VALUES ('test', 'straggler', $1)`, [
      `${month.slice(0, 4)}-${month.slice(4)}-15T10:00:00Z`,
    ]);
    const where = async () =>
      (await q<{ part: string }>(`SELECT tableoid::regclass::text AS part FROM audit_log WHERE action = 'straggler'`))[0]!.part;
    expect(await where()).toBe('audit_log_default');

    const [r] = await q<{ n: number }>(`SELECT ensure_month_partitions('audit_log', $1) AS n`, [MONTHS_AHEAD + 2]);
    expect(r!.n).toBe(2);
    expect(await where()).toBe(`audit_log_p${month}`);
    // Still append-only, on the new partition and on the default that was detached and attached again.
    await expect(q(`UPDATE audit_log SET action = 'tampered' WHERE action = 'straggler'`)).rejects.toThrow(/append-only/);
    const [trg] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'audit_log_default'::regclass AND tgname = 'audit_log_append_only'`,
    );
    expect(trg!.n).toBe(1);
  });

  it('runs the maintenance job as a no-op until a future partition is missing, then recreates it', async () => {
    const scheduler = new Scheduler(t.database.db);
    scheduler.register(partitionMaintenanceJob);
    expect(await scheduler.runOnce(partitionMaintenanceJob.name)).toBe(0);
    const last = `order_events_p${monthFromNow(MONTHS_AHEAD)}`;
    await q(`DROP TABLE ${last}`);
    expect(await scheduler.runOnce(partitionMaintenanceJob.name)).toBe(1);
    expect((await q<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [last]))[0]!.r).toBe(last);
  });

  it('runs a consumer once per event even when deliveries race', async () => {
    const event = { id: randomUUID(), topic: 'test.race', aggregateId: 'a', payload: {}, createdAt: new Date() };
    let runs = 0;
    const handler = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 50));
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runIdempotent(t.database.db, 'race-consumer', event, handler)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(runs).toBe(1);
  });
});

// The hard case: a database that tracks main already ran later migrations (0060, 0080) before these arrive.
describe('@lite migration 0051 converts event logs that already hold rows, after later migrations ran', () => {
  const all = loadMigrations(MIGRATIONS_DIR);
  let t: TestDb;
  const orderId = randomUUID();
  beforeAll(async () => {
    t = await createTestDb({ migrations: all.filter((m) => !['0050', '0051', '0052'].includes(m.version)) });
    const q = (text: string, params: unknown[] = []) => t.database.query(text, params);
    await q(
      `INSERT INTO orders (id, number, status, payment_method, subject, customer_token, address_token, place_of_supply,
         subtotal_paise, tax_paise, total_paise, access_token_hash, created_at)
       VALUES ($1, 'AB-1', 'paid', 'online', 'customer:cus_x', 'cus_x', 'adr_x', 'DL', 100, 18, 118, 'h', '2025-01-10T00:00:00Z')`,
      [orderId],
    );
    await q(
      `INSERT INTO order_events (order_id, to_status, actor, created_at)
       VALUES ($1, 'pending_payment', 'customer:cus_x', '2025-01-10T00:00:00Z'), ($1, 'paid', 'system', '2025-02-03T00:00:00Z')`,
      [orderId],
    );
    await q(
      `INSERT INTO outbox_events (topic, aggregate_id, created_at, published_at)
       VALUES ('order.created', $1, '2025-01-10T00:00:00Z', '2025-01-10T00:00:01Z'), ('order.paid', $1, '2025-02-03T00:00:00Z', NULL)`,
      [orderId],
    );
    await q(`INSERT INTO processed_events (consumer, event_id, processed_at) VALUES ('c', gen_random_uuid(), '2025-01-10T00:00:02Z')`);
    await q(`INSERT INTO webhook_events (provider, event_id, payload, received_at) VALUES ('mock', 'evt_1', '{}', '2025-02-03T00:00:00Z')`);
    await q(`INSERT INTO analytics_events (kind, at) VALUES ('search', '2025-01-11T00:00:00Z')`);
    await q(`INSERT INTO audit_log (actor, action, at) VALUES ('admin', 'policy.updated', '2025-01-12T00:00:00Z')`);
    await q(
      `INSERT INTO llm_traces (channel, tier, model, intent, input_redacted, output_redacted, at)
       VALUES ('chat', 0, 'template', 'greet', 'in', 'out', '2025-01-12T00:00:00Z')`,
    );
    await migrate(t.database, all);
  });
  afterAll(async () => t.cleanup());
  const q = <T>(text: string, params?: unknown[]) => t.database.query<T>(text, params);

  it('keeps every row, in the partition of its month, with its id', async () => {
    const counts = await q<{ t: string; n: number }>(
      `SELECT 'order_events' AS t, count(*)::int AS n FROM order_events UNION ALL SELECT 'outbox_events', count(*)::int FROM outbox_events
       UNION ALL SELECT 'processed_events', count(*)::int FROM processed_events UNION ALL SELECT 'webhook_events', count(*)::int FROM webhook_events
       UNION ALL SELECT 'analytics_events', count(*)::int FROM analytics_events UNION ALL SELECT 'audit_log', count(*)::int FROM audit_log
       UNION ALL SELECT 'llm_traces', count(*)::int FROM llm_traces`,
    );
    expect(Object.fromEntries(counts.map((c) => [c.t, c.n]))).toEqual({
      order_events: 2,
      outbox_events: 2,
      processed_events: 1,
      webhook_events: 1,
      analytics_events: 1,
      audit_log: 1,
      llm_traces: 1,
    });
    const events = await q<{ id: number; part: string }>(`SELECT id, tableoid::regclass::text AS part FROM order_events ORDER BY id`);
    expect(events).toEqual([
      { id: 1, part: 'order_events_p202501' },
      { id: 2, part: 'order_events_p202502' },
    ]);
    const [months] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'order_events'::regclass`,
    );
    // Every month from January 2025 to three months ahead, plus the default.
    const span = (Number(monthFromNow(0).slice(0, 4)) - 2025) * 12 + Number(monthFromNow(0).slice(4)) + MONTHS_AHEAD;
    expect(months!.n).toBe(span + 1);
  });

  it('continues the id sequence and keeps the foreign key and the pending outbox event', async () => {
    const [next] = await q<{ id: number }>(
      `INSERT INTO order_events (order_id, to_status, actor) VALUES ($1, 'shipped', 'admin') RETURNING id`,
      [orderId],
    );
    expect(next!.id).toBe(3);
    await expect(
      q(`INSERT INTO order_events (order_id, to_status, actor) VALUES ($1, 'paid', 'system')`, [randomUUID()]),
    ).rejects.toThrow(/foreign key/);
    const [pending] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
    expect(pending!.n).toBe(1);
  });

  it("keeps 0080's outbox order (identity seq and its index) and 0060's trace kind check", async () => {
    expect((await q<{ seq: number }>(`SELECT seq FROM outbox_events ORDER BY seq`)).map((r) => r.seq)).toEqual([1, 2]);
    const [next] = await q<{ seq: number }>(`INSERT INTO outbox_events (topic, aggregate_id) VALUES ('t', 'a') RETURNING seq`);
    expect(next!.seq).toBe(3);
    const [idx] = await q<{ kind: string }>(`SELECT relkind::text AS kind FROM pg_class WHERE relname = 'outbox_pending_aggregate_idx'`);
    expect(idx?.kind).toBe('I'); // a partitioned index, on every partition
    await expect(
      q(`INSERT INTO llm_traces (channel, tier, model, intent, input_redacted, output_redacted, kind) VALUES ('chat', 0, 'm', 'i', 'a', 'b', 'bogus')`),
    ).rejects.toThrow(/check constraint/);
  });
});
