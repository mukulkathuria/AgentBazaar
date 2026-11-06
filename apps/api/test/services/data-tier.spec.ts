import type { Counter, Gauge } from '@prometheus-io/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresDatabase, type Database } from '../../src/shared/db/database.js';
import { adminToken, call, createShopApp, ok, type ShopApp } from '../support/shop.js';
import { DATA_TIER, docker, PGBOUNCER_URL, REPLICA_URL, sleep, waitFor, withUrl } from './data-tier.js';

const REPLICA_PORT = new URL(REPLICA_URL).port;
const MAX_LAG_MS = 1_000;
const SLUG = 'dt-read-your-writes';
const PRODUCT = {
  slug: SLUG,
  name: 'Read-your-writes probe',
  brand: 'Data Tier',
  description: 'Created while the replica is paused.',
  categoryPath: 'electronics',
  hsnCode: '8471',
  variants: [{ sku: 'DT-RYW-1', title: 'Default', pricePaise: 10_000, mrpPaise: 12_000, costPricePaise: 5_000, stock: 5 }],
};
/** A principal that never writes: anonymous callers are told apart by IP. */
const STRANGER = '10.9.8.7';

describe.skipIf(!DATA_TIER)('@growth read/write routing: primary behind PgBouncer plus a streaming replica', () => {
  let app: ShopApp;
  /** The admin who writes; logged in once (a TOTP code is accepted once). */
  let token: string;
  /** Superuser session on the replica itself, to pause and resume WAL replay. */
  let replica: Database;
  const previousTestUrl = process.env.TEST_DATABASE_URL;

  beforeAll(async () => {
    // The app's primary goes through PgBouncer (transaction pooling); its replica pool connects directly.
    process.env.TEST_DATABASE_URL = PGBOUNCER_URL;
    app = await createShopApp({
      env: (url) => ({
        DATABASE_REPLICA_URLS: withUrl(url!, { port: REPLICA_PORT }),
        DATABASE_REPLICA_MAX_LAG_MS: String(MAX_LAG_MS),
      }),
    });
    replica = createPostgresDatabase({ url: REPLICA_URL, poolMax: 1 });
  }, 180_000);

  afterAll(async () => {
    await replica?.query('SELECT pg_wal_replay_resume()').catch(() => undefined);
    await replica?.close();
    await app?.close();
    if (previousTestUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previousTestUrl;
  });

  const router = () => app.infra.replicas!;

  async function metric(name: string, labels: Record<string, string> = {}): Promise<number> {
    const m = app.infra.metrics.registry.getSingleMetric(name) as Counter | Gauge | undefined;
    const values = m ? (await m.get()).values : [];
    return values.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;
  }
  const reads = (route: string) => metric('agentbazaar_db_reads_total', { route });
  const inRotation = async () => (await metric('agentbazaar_db_replica_healthy')) === 1;

  /** Runs lag checks (the API runs them on a timer) until the replica is in, or out of, read rotation. */
  async function settle(want: boolean): Promise<void> {
    await waitFor(`the replica to ${want ? 'join' : 'leave'} the read rotation`, async () => {
      await router().check();
      return (await inRotation()) === want;
    });
  }

  function getProduct(opts: { token?: string; ip?: string } = {}) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/products/${SLUG}`,
      remoteAddress: opts.ip ?? '127.0.0.1',
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    });
  }

  it("serves a principal's own write from the primary while the replica lags, and others from the replica", async () => {
    token = await adminToken(app);
    await settle(true);
    await replica.query('SELECT pg_wal_replay_pause()');
    await router().check();
    expect(await inRotation()).toBe(true); // paused, but nothing has been written since: still within the lag limit

    ok(await call(app, 'POST', '/api/v1/admin/products', { token, body: PRODUCT }), 201);
    const ryw = await reads('primary_read_your_writes');
    expect(ok<{ name: string }>(await getProduct({ token }), 200).name).toBe(PRODUCT.name);
    expect(await reads('primary_read_your_writes')).toBeGreaterThan(ryw);

    const fromReplica = await reads('replica');
    expect((await getProduct({ ip: STRANGER })).statusCode).toBe(404); // the paused replica has not replayed it yet
    expect(await reads('replica')).toBeGreaterThan(fromReplica);
  });

  it('takes a replica lagging past DATABASE_REPLICA_MAX_LAG_MS out of rotation and readmits it once it catches up', async () => {
    await sleep(MAX_LAG_MS + 300);
    await router().check();
    expect(await inRotation()).toBe(false);
    expect(await metric('agentbazaar_db_replica_lag_seconds')).toBeGreaterThan(MAX_LAG_MS / 1_000);
    ok(await getProduct({ ip: STRANGER }), 200); // primary: nobody reads the stale replica now

    await replica.query('SELECT pg_wal_replay_resume()');
    await settle(true);
    const [fromReplica, ryw] = [await reads('replica'), await reads('primary_read_your_writes')];
    ok(await getProduct({ ip: STRANGER }), 200);
    ok(await getProduct({ token }), 200);
    expect(await reads('replica')).toBeGreaterThan(fromReplica);
    expect(await reads('primary_read_your_writes')).toBe(ryw); // the replica has replayed the admin's write
  });

  it('falls back to the primary when the replica goes down, and readmits it when it returns', async () => {
    await settle(true);
    await docker('stop', 'ab-dt-replica-1');
    try {
      const fallbacks = await reads('primary_fallback');
      ok(await getProduct({ ip: STRANGER }), 200); // no error reaches the caller
      expect(await reads('primary_fallback')).toBeGreaterThan(fallbacks);
      await router().check();
      expect(await inRotation()).toBe(false);
      const noReplica = await reads('primary_no_replica');
      ok(await getProduct({ ip: STRANGER }), 200);
      expect(await reads('primary_no_replica')).toBeGreaterThan(noReplica);
    } finally {
      await docker('start', 'ab-dt-replica-1');
    }
    await settle(true);
    const fromReplica = await reads('replica');
    ok(await getProduct({ ip: STRANGER }), 200);
    expect(await reads('replica')).toBeGreaterThan(fromReplica);
  }, 120_000);
});
