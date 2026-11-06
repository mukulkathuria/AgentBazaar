import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDatabase, type Database } from '../../src/shared/db/database.js';
import { MONTHS_AHEAD } from '../../src/shared/partitions/partitions.js';
import { createTestDb, usingRealPostgres, type TestDb } from '../support/test-db.js';

/*
 * S3 definition of done: query plans stay stable at 100 million order events. CI loads 1M; set
 * DATA_SCALE_EVENTS=10000000 or 100000000 for local runs (docs/benchmarks/data-scale.md). Every scale must give the
 * same plan shapes and stay inside the same latency budgets.
 */
const N = Number(process.env.DATA_SCALE_EVENTS ?? 1_000_000);
const PER_ORDER = Number(process.env.DATA_SCALE_EVENTS_PER_ORDER ?? 5);
const PARALLEL = Number(process.env.DATA_SCALE_PARALLEL ?? 4);
const ORDERS = Math.floor(N / PER_ORDER);
const CUSTOMERS = Math.max(1, Math.floor(ORDERS / 4)); // about four orders each, spread over the whole history
const PAYMENTS = Math.min(ORDERS, 1_000_000);
const AUX = Math.min(Math.floor(N / 10), 2_000_000); // webhook deliveries and analytics events
const OUTBOX = Math.min(Math.floor(N / 20), 1_000_000); // the outbox keeps ~60 days; older months are archived
const HISTORY_DAYS = 730;
const BULK = ['orders', 'payments', 'order_events', 'outbox_events', 'processed_events', 'webhook_events', 'analytics_events'];

// An order's life: up to ten valid transitions, the first five being the common online-payment path.
const TO = ['pending_payment', 'payment_observed', 'paid', 'shipped', 'delivered', 'return_requested', 'delivered', 'return_requested', 'returned', 'refunded'];
const AFTER = ['0', '1 minute', '2 hours', '1 day', '3 days', '5 days', '6 days', '8 days', '9 days', '12 days'];
if (!(PER_ORDER >= 1 && PER_ORDER <= TO.length)) throw new Error(`DATA_SCALE_EVENTS_PER_ORDER must be 1 to ${TO.length}`);
const lit = (xs: (string | null)[]) => `ARRAY[${xs.map((x) => (x === null ? 'NULL' : `'${x}'`)).join(',')}]`;
const ORDER_AT = `now() - interval '${HISTORY_DAYS} days' + (i::float8 / ${ORDERS}) * interval '${HISTORY_DAYS - 13} days'`;

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const asUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
const orderId = (i: number) => asUuid(md5(`o${i}`));
const customerToken = (c: number) => `cus_${md5(`c${c}`).slice(0, 24)}`;
const pick = (n: number) => 1 + Math.floor(Math.random() * n);
const customerOrders = (c: number) => {
  const ids: string[] = [];
  for (let i = c === 0 ? CUSTOMERS : c; i <= ORDERS; i += CUSTOMERS) ids.push(orderId(i));
  return ids;
};

/** One generated chunk of orders [lo, hi] and their events, payments for the first PAYMENTS orders. */
function orderChunk(lo: number, hi: number): string[] {
  const range = `generate_series(${lo}::bigint, ${hi}::bigint) i`;
  const sqls = [
    `INSERT INTO orders (id, number, status, payment_method, subject, customer_token, address_token, place_of_supply, subtotal_paise,
       tax_paise, total_paise, access_token_hash, payment_expires_at, delivered_at, created_at, updated_at)
     SELECT md5('o' || i)::uuid, 'AB-' || i, 'delivered', CASE WHEN i % 4 = 0 THEN 'cod' ELSE 'online' END, 'customer:' || c.tok, c.tok,
       'adr_' || left(md5('a' || i), 24), 'DL', 100000 + i % 50000, 18000, 118000 + i % 50000, md5('h' || i) || md5('k' || i),
       c.at + interval '30 minutes', c.at + interval '3 days', c.at, c.at + interval '3 days'
     FROM ${range}, LATERAL (SELECT 'cus_' || left(md5('c' || (i % ${CUSTOMERS})), 24) AS tok, ${ORDER_AT} AS at) c`,
    `INSERT INTO order_events (id, order_id, from_status, to_status, actor, note, created_at)
     SELECT (i - 1) * ${PER_ORDER} + s, md5('o' || i)::uuid, (${lit([null, ...TO])})[s], (${lit(TO)})[s],
       CASE WHEN s = 1 THEN 'customer:cus_' || left(md5('c' || (i % ${CUSTOMERS})), 24) WHEN s IN (4, 5) THEN 'admin:ops' ELSE 'system' END,
       CASE WHEN s = 1 THEN 'Waiting for payment' END, ${ORDER_AT} + (${lit(AFTER)})[s]::interval
     FROM ${range}, generate_series(1, ${PER_ORDER}) s`,
  ];
  if (lo <= PAYMENTS) {
    sqls.push(`INSERT INTO payments (id, order_id, provider, status, amount_paise, provider_order_id, payment_url, access_token_hash, created_at)
      SELECT md5('p' || i)::uuid, md5('o' || i)::uuid, 'razorpay', 'captured', 118000, 'order_' || i, 'https://pay.example/' || i,
        md5('t' || i), ${ORDER_AT} FROM generate_series(${lo}::bigint, ${Math.min(hi, PAYMENTS)}::bigint) i`);
  }
  return sqls;
}

const auxiliaryLoads = (): string[] => [
  `INSERT INTO outbox_events (id, topic, aggregate_id, payload, created_at, published_at, next_attempt_at)
   SELECT md5('e' || j)::uuid, (${lit(['order.created', 'order.paid', 'order.shipped', 'order.delivered', 'payment.status_changed', 'inventory.stock_changed', 'catalog.product_upserted', 'negotiation.closed'])})[1 + j % 8],
     md5('o' || (1 + j % ${ORDERS}))::uuid::text, jsonb_build_object('orderId', md5('o' || (1 + j % ${ORDERS}))::uuid), x.at,
     CASE WHEN j > ${OUTBOX - 1000} THEN NULL ELSE x.at + interval '1 second' END, x.at
   FROM generate_series(1, ${OUTBOX}) j, LATERAL (SELECT now() - interval '60 days' + (j::float8 / ${OUTBOX}) * interval '60 days' AS at) x`,
  `INSERT INTO processed_events (consumer, event_id, processed_at)
   SELECT (${lit(['search-indexer', 'analytics-negotiations', 'orders-payments', 'notifications'])})[1 + j % 4], md5('e' || j)::uuid,
     now() - interval '60 days' + (j::float8 / ${OUTBOX}) * interval '60 days' + interval '1 second'
   FROM generate_series(1, ${OUTBOX - 1000}) j`,
  `INSERT INTO webhook_events (provider, event_id, received_at, payload, outcome)
   SELECT 'razorpay', 'evt_' || k, now() - interval '${HISTORY_DAYS} days' + (k::float8 / ${AUX}) * interval '${HISTORY_DAYS - 13} days',
     jsonb_build_object('kind', 'captured', 'providerOrderId', 'order_' || k, 'amountPaise', 118000), 'applied'
   FROM generate_series(1, ${AUX}) k`,
  `INSERT INTO analytics_events (id, kind, ref, data, at)
   SELECT k, (${lit([...Array<string>(10).fill('search'), ...Array<string>(6).fill('view'), 'zero_result_search', 'crawler_hit', 'crawler_hit', 'ai_referral'])})[1 + k % 20],
     '/p/product-' || (k % 5000),
     CASE WHEN k % 20 >= 17 THEN jsonb_build_object('agent', (${lit(['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Bingbot'])})[1 + k % 5])
          ELSE jsonb_build_object('q', 'term ' || (k % 1000)) END,
     now() - interval '${HISTORY_DAYS} days' + (k::float8 / ${AUX}) * interval '${HISTORY_DAYS} days'
   FROM generate_series(1, ${AUX}) k`,
];

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  'Subplans Removed'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

const family = (name: string) => name.replace(/_p\d{6}|_default/g, '');

/**
 * What a plan touches, independent of how many partitions or rows: `table:access` and `index:name` entries.
 * A sequential scan that read no rows (an empty future, default or archived-period partition) costs nothing and
 * is left out.
 */
function shapeOf(plan: PlanNode): { shape: string[]; scanned: Record<string, number>; removed: number; buffers: number } {
  const shape = new Set<string>();
  const scanned: Record<string, Set<string>> = {};
  let removed = 0;
  const visit = (n: PlanNode) => {
    removed += n['Subplans Removed'] ?? 0;
    const ran = (n['Actual Loops'] ?? 1) > 0;
    const rel = n['Relation Name'];
    if (rel && ran) {
      const type = n['Node Type'];
      const read = (n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0);
      const access = type === 'Seq Scan' ? 'seq' : type.startsWith('Tid') ? 'tid' : 'index';
      if (access !== 'seq' || read > 0) shape.add(`${family(rel)}:${access}`);
      (scanned[family(rel)] ??= new Set()).add(rel);
    }
    if (n['Index Name'] && ran) shape.add(`index:${family(n['Index Name'])}`);
    for (const c of n.Plans ?? []) visit(c);
  };
  visit(plan);
  return {
    shape: [...shape].sort(),
    scanned: Object.fromEntries(Object.entries(scanned).map(([k, v]) => [k, v.size])),
    removed,
    // Pages touched (counts are inclusive of child nodes): the cost of the plan, whatever the disk or cache.
    buffers: (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0),
  };
}

interface Probe {
  name: string;
  sql: string;
  params: () => unknown[];
  /** Hot paths must use indexes only; this is their plan shape at every scale. */
  shape?: string[];
  /** Most partitions of each table that may be scanned (pruning). */
  maxScanned?: Record<string, number>;
  /** Most pages one execution may touch: the plan's cost, independent of disk speed. */
  maxBuffers?: number;
  /** p95 latency budget. Generous: on a shared host it mostly measures disk reads, which buffers already bound. */
  budgetMs: number;
  write?: boolean;
}

const MONTH_PARTS = 25 + MONTHS_AHEAD + 1; // data months (+1 at a boundary), months ahead, default
const RECENT = 2 + MONTHS_AHEAD + 1; // this month (and last, near a boundary), months ahead, default

const PROBES = (oldest: string): Probe[] => [
  {
    name: 'customer order history: orders',
    sql: `SELECT o.*, (SELECT p.payment_url FROM payments p WHERE p.order_id = o.id AND p.provider <> 'cod'
            ORDER BY p.created_at DESC LIMIT 1) AS payment_url
          FROM orders o WHERE (o.customer_token = $1 OR o.subject = $2) ORDER BY o.created_at DESC, o.id LIMIT 20 OFFSET 0`,
    params: () => {
      const tok = customerToken(pick(CUSTOMERS) - 1);
      return [tok, `customer:${tok}`];
    },
    shape: ['index:orders_customer_idx', 'index:orders_subject_idx', 'index:payments_order_idx', 'orders:index', 'payments:index'],
    budgetMs: 100,
  },
  {
    name: 'customer order history: events',
    sql: `SELECT order_id, to_status, note, created_at FROM order_events WHERE order_id = ANY($1::uuid[])
            AND created_at >= (SELECT min(created_at) - interval '1 day' FROM orders WHERE id = ANY($1::uuid[]))
          ORDER BY id`,
    params: () => [customerOrders(pick(CUSTOMERS) - 1)],
    shape: ['index:order_events_order_id_idx', 'index:orders_pkey', 'order_events:index', 'orders:index'],
    maxScanned: { order_events: MONTH_PARTS },
    budgetMs: 100,
  },
  {
    name: 'events for one recent order',
    sql: `SELECT order_id, to_status, note, created_at FROM order_events WHERE order_id = ANY($1::uuid[])
            AND created_at >= (SELECT min(created_at) - interval '1 day' FROM orders WHERE id = ANY($1::uuid[]))
          ORDER BY id`,
    params: () => [[orderId(ORDERS - pick(Math.max(1, Math.floor(ORDERS / 100))) + 1)]],
    shape: ['index:order_events_order_id_idx', 'index:orders_pkey', 'order_events:index', 'orders:index'],
    maxScanned: { order_events: RECENT + 1 },
    budgetMs: 50,
  },
  {
    name: 'recent events by type (admin feed)',
    sql: `SELECT id, kind, ref, at FROM analytics_events WHERE kind = $1 AND at > now() - interval '1 day' ORDER BY at DESC LIMIT 50`,
    params: () => [['search', 'view', 'crawler_hit'][pick(3) - 1]],
    shape: ['analytics_events:index', 'index:analytics_events_kind_at_idx'],
    maxScanned: { analytics_events: RECENT },
    budgetMs: 50,
  },
  {
    name: 'outbox relay claim',
    sql: `UPDATE outbox_events SET next_attempt_at = now() + interval '30 seconds'
          WHERE (id, created_at) IN (
            SELECT id, created_at FROM outbox_events WHERE published_at IS NULL AND next_attempt_at <= now()
            ORDER BY created_at, id LIMIT 100 FOR UPDATE SKIP LOCKED)
          RETURNING id, topic, aggregate_id, payload, created_at, created_at::text AS created_key, attempts`,
    params: () => [],
    shape: ['index:outbox_events_next_attempt_at_created_at_idx', 'index:outbox_events_pkey', 'outbox_events:index'],
    budgetMs: 100,
    write: true,
  },
  {
    name: 'analytics aggregate: GEO (30 days)',
    sql: `SELECT kind, coalesce(data->>'agent', 'unknown') AS agent, count(*)::int AS n FROM analytics_events
          WHERE kind IN ('crawler_hit', 'ai_referral') AND at > now() - interval '30 days' GROUP BY 1, 2`,
    params: () => [],
    maxScanned: { analytics_events: RECENT },
    budgetMs: 2000,
  },
  {
    name: 'analytics aggregate: search totals (30 days)',
    sql: `SELECT count(*) FILTER (WHERE kind = 'search')::int AS searches, count(*) FILTER (WHERE kind = 'zero_result_search')::int AS zero
          FROM analytics_events WHERE kind IN ('search', 'zero_result_search') AND at > now() - interval '30 days'`,
    params: () => [],
    maxScanned: { analytics_events: RECENT },
    budgetMs: 2000,
  },
  {
    name: 'archive: partition selection',
    sql: `SELECT c.relname AS name, p.relname AS parent FROM pg_class c
            LEFT JOIN pg_inherits i ON i.inhrelid = c.oid LEFT JOIN pg_class p ON p.oid = i.inhparent
          WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace AND c.relname ~ '_p[0-9]{6}$'
          ORDER BY c.relname`,
    params: () => [],
    budgetMs: 200,
  },
  {
    name: 'archive: export batch (8 MB of one partition)',
    sql: `SELECT row_to_json(t)::text AS line FROM "${oldest}" t WHERE ctid >= $1::tid AND ctid < $2::tid`,
    params: () => ['(0,0)', '(1024,0)'],
    shape: ['order_events:tid'],
    budgetMs: 2000,
  },
];

const RUNS = 40;
const WARMUP = 3;
const ROLLBACK = new Error('rollback');
const report: Record<string, unknown> = { orderEvents: N, orders: ORDERS, customers: CUSTOMERS, eventsPerOrder: PER_ORDER };

describe.skipIf(!usingRealPostgres())(`@scale data scale: plans stay stable at ${N.toLocaleString('en')} order events`, () => {
  let t: TestDb;
  let db: Database;
  let oldest = '';

  // In a rolled-back transaction when the statement writes, so every run sees the same data.
  async function run<T>(probe: Probe, sql: string, params: unknown[]): Promise<T[]> {
    if (!probe.write) return db.query<T>(sql, params);
    let out: T[] = [];
    await db
      .scriptTransaction(async (s) => {
        out = await s.query<T>(sql, params);
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    return out;
  }

  beforeAll(async () => {
    t = await createTestDb();
    db = createPostgresDatabase({ url: t.url!, poolMax: PARALLEL + 1, statementTimeoutMs: 0 });
    const q = (sql: string, params?: unknown[]) => db.query(sql, params);
    const t0 = performance.now();
    for (const table of BULK.filter((b) => b !== 'orders' && b !== 'payments')) {
      await q(`SELECT ensure_month_partitions($1, ${MONTHS_AHEAD}, (now() - interval '${HISTORY_DAYS} days')::date)`, [table]);
    }
    // Load first, then build indexes: capture every key and index on (or pointing at) the bulk tables and drop them.
    const keys = await db.query<{ tbl: string; name: string; def: string; type: string }>(
      `SELECT conrelid::regclass::text AS tbl, conname AS name, pg_get_constraintdef(oid) AS def, contype AS type FROM pg_constraint
       WHERE (conrelid = ANY($1::regclass[]) OR confrelid = ANY($1::regclass[])) AND contype IN ('p', 'u', 'f') AND conparentid = 0`,
      [BULK],
    );
    const indexes = await db.query<{ name: string; def: string }>(
      `SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS def FROM pg_index i
       WHERE indrelid = ANY($1::regclass[]) AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)`,
      [BULK],
    );
    for (const k of keys.filter((k) => k.type === 'f')) await q(`ALTER TABLE ${k.tbl} DROP CONSTRAINT ${k.name}`);
    for (const k of keys.filter((k) => k.type !== 'f')) await q(`ALTER TABLE ${k.tbl} DROP CONSTRAINT ${k.name}`);
    for (const i of indexes) await q(`DROP INDEX ${i.name}`);

    const chunk = Math.max(50_000, Math.ceil(ORDERS / (PARALLEL * 4)));
    const jobs: (() => Promise<void>)[] = auxiliaryLoads().map((sql) => async () => void (await q(sql)));
    for (let lo = 1; lo <= ORDERS; lo += chunk) {
      const sqls = orderChunk(lo, Math.min(ORDERS, lo + chunk - 1));
      jobs.push(async () => {
        for (const sql of sqls) await q(sql);
      });
    }
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) await job();
    }));
    const t1 = performance.now();
    for (const k of keys.filter((k) => k.type !== 'f')) await q(`ALTER TABLE ${k.tbl} ADD CONSTRAINT ${k.name} ${k.def}`);
    for (const i of indexes) await q(i.def.replace(' ON ONLY ', ' ON '));
    for (const k of keys.filter((k) => k.type === 'f')) await q(`ALTER TABLE ${k.tbl} ADD CONSTRAINT ${k.name} ${k.def}`);
    const t2 = performance.now();
    // VACUUM as well as ANALYZE: the steady state of a live table, and no autovacuum storm during the probes.
    await q(`VACUUM (ANALYZE) ${BULK.join(', ')}`);
    const t3 = performance.now();
    // A plain table counts itself; a partitioned one counts its leaf partitions.
    const sizes = await db.query<{ tbl: string; rows: number; mb: number }>(
      `SELECT b.tbl, sum(c.reltuples)::bigint AS rows, round(sum(pg_total_relation_size(c.oid)) / 1048576.0) AS mb
       FROM unnest($1::text[]) b(tbl)
       JOIN pg_class c ON c.oid = b.tbl::regclass OR c.oid IN (SELECT relid FROM pg_partition_tree(b.tbl::regclass) WHERE isleaf)
       WHERE c.relkind = 'r' GROUP BY b.tbl ORDER BY b.tbl`,
      [BULK],
    );
    const [total] = await db.query<{ mb: number }>(`SELECT round(pg_database_size(current_database()) / 1048576.0) AS mb`);
    oldest = (await db.query<{ name: string }>(`SELECT min(relname) AS name FROM pg_class WHERE relname ~ '^order_events_p[0-9]{6}$'`))[0]!
      .name;
    Object.assign(report, {
      loadSeconds: Math.round((t1 - t0) / 1000),
      indexSeconds: Math.round((t2 - t1) / 1000),
      vacuumAnalyzeSeconds: Math.round((t3 - t2) / 1000),
      databaseMb: total!.mb,
      tables: sizes,
      probes: {},
    });
    console.log(JSON.stringify(report));
  }, 60_000 + Math.ceil(N / 1_000_000) * 120_000);

  afterAll(async () => {
    await db?.close();
    await t?.cleanup();
    if (process.env.DATA_SCALE_REPORT) writeFileSync(process.env.DATA_SCALE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }, 600_000);

  for (const index of PROBES('').keys()) {
    it(`${PROBES('')[index]!.name}: same plan shape and inside its budget`, async () => {
      const probe = PROBES(oldest)[index]!;
      const [explained] = await run<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(probe, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe.sql}`, probe.params());
      const plan = shapeOf(explained!['QUERY PLAN'][0].Plan);
      const text = await run<{ 'QUERY PLAN': string }>(probe, `EXPLAIN (ANALYZE, COSTS OFF, BUFFERS) ${probe.sql}`, probe.params());
      const times: number[] = [];
      for (let r = 0; r < WARMUP + RUNS; r++) {
        const params = probe.params();
        const start = performance.now();
        await run(probe, probe.sql, params);
        if (r >= WARMUP) times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const p50 = times[Math.floor(RUNS / 2)]!;
      const p95 = times[Math.ceil(RUNS * 0.95) - 1]!;
      (report.probes as Record<string, unknown>)[probe.name] = {
        ...plan,
        p50: +p50.toFixed(2),
        p95: +p95.toFixed(2),
        budgetMs: probe.budgetMs,
        plan: text.map((l) => l['QUERY PLAN']),
      };
      if (probe.shape) expect(plan.shape).toEqual(probe.shape);
      for (const [table, max] of Object.entries(probe.maxScanned ?? {})) expect(plan.scanned[table] ?? 0).toBeLessThanOrEqual(max);
      if (probe.maxBuffers) expect(plan.buffers).toBeLessThanOrEqual(probe.maxBuffers);
      expect(p95).toBeLessThanOrEqual(probe.budgetMs);
    }, 120_000);
  }
});
