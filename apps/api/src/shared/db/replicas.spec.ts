import { type Counter, type Gauge, Registry } from '@prometheus-io/client';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache, type Cache } from '../cache/cache.js';
import { createLogger } from '../observability/logger.js';
import { inTransaction, rows, type Database, type Executor } from './database.js';
import { ReplicaRouter, type ReadScope } from './replicas.js';

/** A scripted server: its WAL position, whether it is a standby, and how it fails. */
interface Server {
  lsn: number;
  standby: boolean;
  down: boolean;
  sqlError: boolean;
}

function fakeDatabase(name: string, s: Server): Database {
  const db = {
    execute: async () => {
      if (s.down) throw new Error('connect ECONNREFUSED');
      if (s.sqlError) throw new pg.DatabaseError('relation "nope" does not exist', 0, 'error');
      return { rows: [{ server: name }], fields: [] };
    },
    transaction: async (fn: (tx: Executor) => Promise<unknown>) => fn(db),
  } as unknown as Executor;
  return {
    driver: 'postgres',
    db,
    async query<T>(text: string) {
      if (s.down) throw new Error('connect ECONNREFUSED');
      const row = text.includes('pg_is_in_recovery') ? { standby: s.standby, lsn: s.standby ? s.lsn : null } : { lsn: s.lsn };
      return [row as T];
    },
    scriptTransaction: async () => undefined,
    close: async () => undefined,
  };
}

const server = (lsn = 1_000, standby = true): Server => ({ lsn, standby, down: false, sqlError: false });
const get = (subject?: string): ReadScope => ({ method: 'GET', principal: subject ? { subject } : undefined });
const post = (subject: string): ReadScope => ({ method: 'POST', principal: { subject } });

function setup(replicaCount = 1, cache: Cache = new MemoryCache()) {
  const primary = server(1_000, false);
  const replicas = Array.from({ length: replicaCount }, () => server());
  const registry = new Registry();
  const router = new ReplicaRouter(
    fakeDatabase('primary', primary),
    replicas.map((s, i) => ({ name: `r${i + 1}`, database: fakeDatabase(`r${i + 1}`, s) })),
    { cache, maxLagMs: 1_000, registry, logger: createLogger('silent') },
  );
  /** Runs one routed read, inside `scope` when given, and says which server answered. */
  const read = async (scope?: ReadScope): Promise<string> => {
    const run = () => rows<{ server: string }>(router.reads, sql`SELECT 1`);
    const [row] = scope ? await router.scope.run(scope, run) : await run();
    return row!.server;
  };
  const metric = async (name: string, labels: Record<string, string>) => {
    const m = (await (registry.getSingleMetric(name) as Counter | Gauge).get()).values;
    return m.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;
  };
  return { router, primary, replicas, read, metric };
}

describe('ReplicaRouter', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0, toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('uses a replica only for GET and HEAD reads, and only after a check has admitted it', async () => {
    const { router, read, metric } = setup();
    expect(await read(get())).toBe('primary');
    expect(await metric('agentbazaar_db_reads_total', { route: 'primary_no_replica' })).toBe(1);

    await router.check();
    expect(await read(get())).toBe('r1');
    expect(await read({ method: 'HEAD' })).toBe('r1');
    expect(await read(post('alice'))).toBe('primary');
    expect(await read()).toBe('primary');
    expect(await metric('agentbazaar_db_reads_total', { route: 'replica' })).toBe(2);
    expect(await metric('agentbazaar_db_reads_total', { route: 'primary_write_path' })).toBe(2);
    expect(await metric('agentbazaar_db_replica_healthy', { replica: 'r1' })).toBe(1);
  });

  it("sends a principal's reads to the primary until a replica has replayed its last write", async () => {
    const { router, primary, replicas, read, metric } = setup();
    await router.check();
    primary.lsn = 2_000;
    await router.recordWrites(post('alice'));

    expect(await read(get('alice'))).toBe('primary');
    expect(await read(get('bob'))).toBe('r1');
    expect(await metric('agentbazaar_db_reads_total', { route: 'primary_read_your_writes' })).toBe(1);

    replicas[0]!.lsn = 1_975; // 25 bytes short: more than a page header, so the write may be missing
    await router.check();
    expect(await read(get('alice'))).toBe('primary');
    replicas[0]!.lsn = 1_976; // only a page header short: the write is replayed
    await router.check();
    expect(await read(get('alice'))).toBe('r1');
  });

  it('records writes only for mutating requests with a principal, and keeps the later of two positions', async () => {
    const { router, primary, replicas, read } = setup();
    await router.check();
    primary.lsn = 3_000;
    await router.recordWrites(get('carol'));
    await router.recordWrites({ method: 'POST' });
    expect(await read(get('carol'))).toBe('r1');

    await router.recordWrites(post('alice'));
    primary.lsn = 2_000; // an earlier request's position arriving late must not lower the record
    await router.recordWrites(post('alice'));
    replicas[0]!.lsn = 2_500;
    await router.check();
    expect(await read(get('alice'))).toBe('primary');
  });

  it('pins a principal to the primary when its write position cannot be read or recorded', async () => {
    const failing = Object.assign(new MemoryCache(), { get: () => Promise.reject(new Error('cache down')) });
    const { router, read } = setup(1, failing);
    await router.check();
    expect(await read(get('alice'))).toBe('primary');
    expect(await read(get())).toBe('r1');

    const other = setup();
    await other.router.check();
    other.primary.down = true;
    await other.router.recordWrites(post('alice'));
    other.primary.down = false;
    expect(await other.read(get('alice'))).toBe('primary');
    expect(await other.read(get('bob'))).toBe('r1');
  });

  it('ejects a replica lagging more than the limit and readmits it once it catches up', async () => {
    const { router, primary, replicas, read, metric } = setup();
    await router.check();
    primary.lsn = 5_000;
    vi.setSystemTime(600);
    await router.check();
    expect(await read(get())).toBe('r1');
    expect(await metric('agentbazaar_db_replica_lag_seconds', { replica: 'r1' })).toBe(0.6);

    vi.setSystemTime(1_200);
    await router.check();
    expect(await read(get())).toBe('primary');
    expect(await metric('agentbazaar_db_replica_lag_seconds', { replica: 'r1' })).toBe(1.2);
    expect(await metric('agentbazaar_db_replica_healthy', { replica: 'r1' })).toBe(0);

    replicas[0]!.lsn = 5_000;
    vi.setSystemTime(1_500);
    await router.check();
    expect(await read(get())).toBe('r1');
    expect(await metric('agentbazaar_db_replica_lag_seconds', { replica: 'r1' })).toBe(0);
  });

  it('treats a replica behind every retained sample as too far behind to measure', async () => {
    const { router, replicas, read, metric } = setup();
    replicas[0]!.lsn = 500;
    await router.check();
    expect(await read(get())).toBe('primary');
    expect(await metric('agentbazaar_db_replica_lag_seconds', { replica: 'r1' })).toBe(Infinity);
  });

  it('falls back to the primary when a replica goes down mid-read, and keeps it out until a check passes', async () => {
    const { router, replicas, read, metric } = setup();
    await router.check();
    replicas[0]!.down = true;
    expect(await read(get())).toBe('primary');
    expect(await metric('agentbazaar_db_reads_total', { route: 'primary_fallback' })).toBe(1);
    expect(await read(get())).toBe('primary');
    expect(await metric('agentbazaar_db_reads_total', { route: 'primary_no_replica' })).toBe(1);

    await router.check();
    expect(await metric('agentbazaar_db_replica_healthy', { replica: 'r1' })).toBe(0);
    replicas[0]!.down = false;
    await router.check();
    expect(await read(get())).toBe('r1');
  });

  it('retries an SQL error on the primary without taking the replica out of rotation', async () => {
    const { router, replicas, read } = setup();
    await router.check();
    replicas[0]!.sqlError = true;
    expect(await read(get())).toBe('primary');
    replicas[0]!.sqlError = false;
    expect(await read(get())).toBe('r1');
  });

  it('never reads from a promoted replica', async () => {
    const { router, replicas, read } = setup();
    replicas[0]!.standby = false;
    await router.check();
    expect(await read(get())).toBe('primary');
  });

  it('spreads reads across healthy replicas and routes read-only transactions like reads', async () => {
    const { router, read } = setup(2);
    await router.check();
    expect([await read(get()), await read(get()), await read(get())]).toEqual(['r1', 'r2', 'r1']);
    const inTx = await router.scope.run(get(), () => inTransaction(router.reads, (tx) => rows<{ server: string }>(tx, sql`SELECT 1`)));
    expect(inTx[0]!.server).toBe('r2');
  });
});
