import { AsyncLocalStorage } from 'node:async_hooks';
import { Counter, Gauge, type Registry } from '@prometheus-io/client';
import pg from 'pg';
import type { Logger } from 'pino';
import type { Cache } from '../cache/cache.js';
import { createPostgresDatabase, type Database, type Executor } from './database.js';

/** The request a read belongs to. Fastify's request fits once the auth guard has set the principal. */
export interface ReadScope {
  readonly method: string;
  readonly principal?: { readonly subject: string } | undefined;
}

export interface ReplicaRouterOptions {
  cache: Cache;
  maxLagMs: number;
  registry: Registry;
  logger: Logger;
}

interface Replica {
  readonly name: string;
  readonly database: Database;
  healthy: boolean;
  /** WAL position replayed at the last check. */
  lsn: number;
}

/** Only reads made while serving GET or HEAD may use a replica; mutating requests read their own writes on the primary. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const PRIMARY_LSN = `SELECT (pg_current_wal_insert_lsn() - '0/0'::pg_lsn)::bigint AS lsn`;
const REPLICA_STATE = `SELECT pg_is_in_recovery() AS standby, (pg_last_wal_replay_lsn() - '0/0'::pg_lsn)::bigint AS lsn`;
/**
 * An idle primary's insert position can sit just past a WAL page header that replay never reports as reached.
 * Every commit record is longer than a page header, so this slack cannot hide an unreplayed commit.
 */
const PAGE_HEADER_BYTES = 24;
const covers = (replayed: number, lsn: number): boolean => replayed + PAGE_HEADER_BYTES >= lsn;
const writeKey = (subject: string): string => `ryw:${subject}`;

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Read/write routing for streaming replicas (ADR 0009). `reads` serves explicitly chosen safe reads: it uses a
 * replica only inside a GET or HEAD request, only while the replica is healthy (reachable, in recovery, lagging at
 * most maxLagMs) and only once it has replayed the WAL position recorded after the reading principal's last write.
 * Everything else, including every transaction opened on `db`, runs on the primary.
 */
export class ReplicaRouter {
  readonly scope = new AsyncLocalStorage<ReadScope>();
  /** Catalog, search, recommendations and analytics reads; never anything that decides money, stock, quotes or auth. */
  readonly reads: Executor;
  readonly checkEveryMs: number;
  private readonly replicas: Replica[];
  /** The primary's WAL position over the last maxLagMs, oldest first. */
  private readonly samples: { at: number; lsn: number }[] = [];
  private readonly lastWrites = new WeakMap<ReadScope, Promise<number>>();
  private readonly routed: Counter<'route'>;
  private readonly lag: Gauge<'replica'>;
  private readonly inRotation: Gauge<'replica'>;
  /** Long enough that a record expires only after any replica still behind it has been ejected for lag. */
  private readonly writeTtlSeconds: number;
  private next = 0;
  private timer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | undefined;

  constructor(
    private readonly primary: Database,
    replicas: readonly { name: string; database: Database }[],
    private readonly opts: ReplicaRouterOptions,
  ) {
    this.replicas = replicas.map((r) => ({ ...r, healthy: false, lsn: 0 }));
    this.checkEveryMs = Math.min(1_000, Math.ceil(opts.maxLagMs / 4));
    this.writeTtlSeconds = Math.ceil(opts.maxLagMs / 1_000) + 60;
    const registers = [opts.registry];
    this.routed = new Counter({
      name: 'agentbazaar_db_reads_total',
      help: 'Routable reads by where they ran: replica, or primary and why',
      labelNames: ['route'] as const,
      registers,
    });
    this.lag = new Gauge({
      name: 'agentbazaar_db_replica_lag_seconds',
      help: 'Replica lag behind the primary at the last check (upper bound, to within one check interval)',
      labelNames: ['replica'] as const,
      registers,
    });
    this.inRotation = new Gauge({
      name: 'agentbazaar_db_replica_healthy',
      help: '1 while the replica is in read rotation',
      labelNames: ['replica'] as const,
      registers,
    });
    // Inherits everything from the primary handle; only raw reads and their read-only transactions are routed.
    this.reads = Object.assign(Object.create(primary.db) as Executor, {
      execute: (query: Parameters<Executor['execute']>[0]) => this.route((ex) => ex.execute(query)),
      transaction: (...args: Parameters<Executor['transaction']>) => this.route((ex) => ex.transaction(...args)),
    });
  }

  /**
   * Runs before a response is sent. After a request that may have written, the principal's later reads must see
   * those writes, so they may use only replicas that have replayed past the primary's current position.
   */
  async recordWrites(scope: ReadScope): Promise<void> {
    const subject = scope.principal?.subject;
    if (!subject || SAFE_METHODS.has(scope.method)) return;
    // Unknown position: pin the principal to the primary until the record expires.
    const lsn = await this.primaryLsn().catch(() => Number.MAX_SAFE_INTEGER);
    try {
      await this.opts.cache.setMax(writeKey(subject), lsn, this.writeTtlSeconds);
    } catch (err) {
      this.opts.logger.error({ err }, 'could not record a write position; this principal may read stale replica data');
    }
  }

  /** Samples the primary's WAL position, then measures every replica against the samples. Never throws. */
  async check(): Promise<void> {
    const now = Date.now();
    try {
      this.samples.push({ at: now, lsn: await this.primaryLsn() });
    } catch (err) {
      // Replicas are then judged against the last known position, so they keep serving reads while the primary is away.
      this.opts.logger.warn({ err }, 'replica check could not reach the primary');
    }
    const keepMs = this.opts.maxLagMs + this.checkEveryMs;
    while (this.samples.length > 1 && now - this.samples[0]!.at > keepMs) this.samples.shift();
    await Promise.all(this.replicas.map((r) => this.measure(r, now)));
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      this.checking ??= this.check().finally(() => (this.checking = undefined));
    };
    tick();
    this.timer = setInterval(tick, this.checkEveryMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.checking;
    await Promise.all(this.replicas.map((r) => r.database.close().catch(() => undefined)));
  }

  private async route<T>(op: (ex: Executor) => PromiseLike<T>): Promise<T> {
    const replica = await this.choose();
    if (!replica) return op(this.primary.db);
    try {
      return await op(replica.database.db);
    } catch (err) {
      // A broken connection also takes the replica out of rotation until its next check; an SQL error does not.
      if (!(err instanceof pg.DatabaseError)) replica.healthy = false;
      this.routed.inc({ route: 'primary_fallback' });
      this.opts.logger.warn({ err, replica: replica.name }, 'replica read failed; retrying on the primary');
      return op(this.primary.db);
    }
  }

  /** The replica a read may use, or undefined for the primary. */
  private async choose(): Promise<Replica | undefined> {
    const scope = this.scope.getStore();
    if (!scope || !SAFE_METHODS.has(scope.method)) return this.toPrimary('primary_write_path');
    if (!this.replicas.some((r) => r.healthy)) return this.toPrimary('primary_no_replica');
    const lastWrite = await this.lastWrite(scope);
    const fresh = this.replicas.filter((r) => r.healthy && covers(r.lsn, lastWrite));
    if (!fresh.length) return this.toPrimary('primary_read_your_writes');
    this.routed.inc({ route: 'replica' });
    return fresh[this.next++ % fresh.length];
  }

  private toPrimary(route: string): undefined {
    this.routed.inc({ route });
    return undefined;
  }

  /** The WAL position recorded after the principal's last write (0 if none), looked up once per request. */
  private lastWrite(scope: ReadScope): Promise<number> {
    const subject = scope.principal?.subject;
    if (!subject) return Promise.resolve(0);
    let pending = this.lastWrites.get(scope);
    if (!pending) {
      // If the record cannot be read, act as if the principal just wrote: the primary is never stale.
      pending = this.opts.cache.get<number>(writeKey(subject)).then(
        (lsn) => lsn ?? 0,
        () => Number.MAX_SAFE_INTEGER,
      );
      this.lastWrites.set(scope, pending);
    }
    return pending;
  }

  private async primaryLsn(): Promise<number> {
    const [row] = await this.primary.query<{ lsn: number }>(PRIMARY_LSN);
    return row!.lsn;
  }

  private async measure(r: Replica, now: number): Promise<void> {
    const was = r.healthy;
    let lagMs = Infinity;
    try {
      const [s] = await within(this.checkEveryMs * 2, r.database.query<{ standby: boolean; lsn: number | null }>(REPLICA_STATE));
      // A promoted server may be on a diverged timeline: it is never read as a replica.
      if (s?.standby && s.lsn !== null) {
        r.lsn = s.lsn;
        lagMs = this.lagMs(s.lsn, now);
      }
    } catch {
      // Unreachable or too slow to answer: out of rotation.
    }
    r.healthy = lagMs <= this.opts.maxLagMs;
    this.lag.set({ replica: r.name }, lagMs / 1_000);
    this.inRotation.set({ replica: r.name }, r.healthy ? 1 : 0);
    if (r.healthy && !was) this.opts.logger.info({ replica: r.name, lagMs }, 'replica back in read rotation');
    if (!r.healthy && was) this.opts.logger.warn({ replica: r.name, lagMs }, 'replica taken out of read rotation');
  }

  /** The replica holds everything the primary had at the newest sample it has reached; lag is the time since then. */
  private lagMs(replayed: number, now: number): number {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]!;
      if (covers(replayed, s.lsn)) return i === this.samples.length - 1 ? 0 : now - s.at;
    }
    return Infinity;
  }
}

/** One pool per DATABASE_REPLICA_URLS entry; metrics and logs name a replica by host, never with its password. */
export function createReplicaRouter(
  primary: Database,
  urls: readonly string[],
  opts: ReplicaRouterOptions & { poolMax: number },
): ReplicaRouter {
  const replicas = urls.map((url, i) => ({
    name: URL.parse(url)?.host || `replica-${i + 1}`,
    // The pool's client-side query timeout turns a hung replica into an error, which falls back to the primary.
    database: createPostgresDatabase({ url, poolMax: opts.poolMax, applicationName: 'agentbazaar-api-replica' }),
  }));
  return new ReplicaRouter(primary, replicas, opts);
}
