import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archivePartitions } from '../../src/shared/partitions/archive.js';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { ADDRESS, BUYER_EMAIL, BUYER_PHONE, buy, call, createShopApp, ok, pay, registerCustomer, type ShopApp } from '../support/shop.js';

const monthFromNow = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
};

async function readLines(file: string): Promise<string[]> {
  return gunzipSync(await readFile(file)).toString('utf8').split('\n').filter(Boolean);
}

describe('@lite archive moves old partitions to gzip JSON lines', () => {
  let t: TestDb;
  let dir: string;
  const tables = ['analytics_events', 'audit_log', 'outbox_events'];
  beforeAll(async () => {
    t = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), 'ab-archive-'));
    const q = (text: string) => t.database.query(text);
    for (const table of tables) await q(`SELECT ensure_month_partitions('${table}', 0, '2025-01-01')`);
    await q(`INSERT INTO analytics_events (kind, ref, at) SELECT 'search', 'q' || i, '2025-01-05'::timestamptz + i * interval '1 day' FROM generate_series(1, 3) i`);
    await q(`INSERT INTO analytics_events (kind, at) VALUES ('view', '2025-02-10T00:00:00Z'), ('view', '2025-02-11T00:00:00Z'), ('view', '2025-03-01T00:00:00Z')`);
    await q(`INSERT INTO audit_log (actor, action, data, at) VALUES ('admin', 'policy.updated', '{"band":"premium"}', '2025-01-20T00:00:00Z')`);
    await q(
      `INSERT INTO outbox_events (topic, aggregate_id, created_at, published_at)
       VALUES ('order.paid', 'o1', '2025-01-10T00:00:00Z', '2025-01-10T00:00:01Z'), ('order.paid', 'o2', '2025-02-10T00:00:00Z', NULL)`,
    );
  });
  afterAll(async () => {
    await t.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  const q = <T>(text: string, params?: unknown[]) => t.database.query<T>(text, params);
  const exists = async (name: string) => (await q<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [name]))[0]!.r !== null;

  it('refuses a malformed month, the current month, both or neither cutoffs, and tables that are not partitioned', async () => {
    await expect(archivePartitions(t.database, { before: '2025-1', dir })).rejects.toThrow(/YYYY-MM/);
    await expect(archivePartitions(t.database, { before: monthFromNow(1), dir })).rejects.toThrow(/current month/);
    await expect(archivePartitions(t.database, { dir })).rejects.toThrow(/either/);
    await expect(archivePartitions(t.database, { before: '2025-03', olderThanMonths: 12, dir })).rejects.toThrow(/either/);
    await expect(archivePartitions(t.database, { before: '2025-03', dir, tables: ['orders'] })).rejects.toThrow(/orders/);
  });

  it('turns --older-than into the first month to keep, counted back from the current month', async () => {
    await q(`SELECT ensure_month_partitions('webhook_events', 0, '2025-01-01')`);
    // On 2025-05-20, keeping 3 whole months before May keeps February onwards: only January goes.
    const done = await archivePartitions(t.database, {
      olderThanMonths: 3,
      dir,
      tables: ['webhook_events'],
      now: new Date('2025-05-20T00:00:00Z'),
    });
    expect(done.map((d) => d.partition)).toEqual(['webhook_events_p202501']);
    expect(await exists('webhook_events_p202502')).toBe(true);
  });

  it('archives earlier months, checks each file against its table, drops it, and skips unpublished outbox events', async () => {
    const done = await archivePartitions(t.database, { before: '2025-03', dir, tables });
    expect(done.map((d) => [d.partition, d.rows])).toEqual([
      ['analytics_events_p202501', 3],
      ['analytics_events_p202502', 2],
      ['audit_log_p202501', 1],
      ['audit_log_p202502', 0],
      ['outbox_events_p202501', 1],
    ]);
    const lines = await readLines(join(dir, 'analytics_events', 'analytics_events_p202501.jsonl.gz'));
    expect(lines.map((l) => (JSON.parse(l) as { ref: string }).ref).sort()).toEqual(['q1', 'q2', 'q3']);
    const manifest = JSON.parse(await readFile(join(dir, 'audit_log', 'audit_log_p202501.manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ table: 'audit_log', month: '2025-01', rows: 1, sha256: done[2]!.sha256 });
    for (const d of done) expect(await exists(d.partition)).toBe(false);
    // The pending event stays attached for the relay; March is not before the cutoff.
    const [pending] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
    expect(pending!.n).toBe(1);
    expect(await exists('analytics_events_p202503')).toBe(true);
    expect(await archivePartitions(t.database, { before: '2025-03', dir, tables })).toEqual([]);
  });

  it('finishes a partition that an interrupted run left detached', async () => {
    const target = join(dir, 'analytics_events', 'analytics_events_p202503.jsonl.gz');
    await mkdir(`${target}.partial`, { recursive: true }); // the export cannot write its temporary file
    await expect(archivePartitions(t.database, { before: '2025-04', dir, tables: ['analytics_events'] })).rejects.toThrow();
    const [attached] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_inherits WHERE inhrelid = 'analytics_events_p202503'::regclass`,
    );
    expect(attached!.n).toBe(0);
    await rm(`${target}.partial`, { recursive: true });
    const done = await archivePartitions(t.database, { before: '2025-04', dir, tables: ['analytics_events'] });
    expect(done.map((d) => [d.partition, d.rows])).toEqual([['analytics_events_p202503', 1]]);
    expect(await readLines(target)).toHaveLength(1);
  });
});

describe('@lite archives reference customers by token only (DPDP)', () => {
  let app: ShopApp;
  let dir: string;
  beforeAll(async () => {
    app = await createShopApp();
    dir = await mkdtemp(join(tmpdir(), 'ab-archive-dpdp-'));
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('archives an order without names, contact details or addresses, and erasure leaves the token unlinkable', async () => {
    const session = await registerCustomer(app, BUYER_EMAIL);
    const { order } = await buy(app, { sku: 'THOCK-TK87-RED', quantity: 1 }, { token: session.accessToken });
    await pay(app, order);
    const [{ customer_token: token }] = (await app.infra.database.query<{ customer_token: string }>(
      'SELECT customer_token FROM orders WHERE id = $1',
      [order.orderId],
    )) as [{ customer_token: string }];

    // Pretend a month has passed, so this month's partitions are old enough to archive.
    const done = await archivePartitions(app.infra.database, {
      before: monthFromNow(1),
      dir,
      now: new Date(`${monthFromNow(1)}-02T00:00:00Z`),
    });
    expect(done.map((d) => d.table)).toEqual(expect.arrayContaining(['order_events', 'outbox_events', 'webhook_events']));
    const text = (await Promise.all(done.map((d) => readLines(d.file)))).flat().join('\n');
    expect(text).toContain(token);
    for (const personal of [BUYER_EMAIL, BUYER_PHONE, ADDRESS.name, ADDRESS.line1, ADDRESS.pincode, 'Test Buyer']) {
      expect(text, `archive leaks "${personal}"`).not.toContain(personal);
    }
    expect((await readdir(join(dir, 'order_events'))).sort()).toEqual([
      `order_events_p${monthFromNow(0).replace('-', '')}.jsonl.gz`,
      `order_events_p${monthFromNow(0).replace('-', '')}.manifest.json`,
    ]);

    ok(await call(app, 'POST', '/api/v1/me/erase', { body: { confirm: 'ERASE' }, token: session.accessToken }), 200);
    const [pii] = await app.infra.database.query<{ wrapped_dek: string | null; email_enc: string | null }>(
      'SELECT wrapped_dek, email_enc FROM pii.customers WHERE token = $1',
      [token],
    );
    expect(pii).toEqual({ wrapped_dek: null, email_enc: null });
  });
});
