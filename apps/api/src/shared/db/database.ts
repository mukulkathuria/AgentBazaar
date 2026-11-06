import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { type SQL } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';

/** A database handle or an open transaction. Repositories accept either. */
export type Executor = PgDatabase<PgQueryResultHKT, Record<string, never>>;

export interface ScriptRunner {
  exec(script: string): Promise<void>;
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Database {
  readonly driver: 'postgres' | 'pglite';
  readonly db: Executor;
  /** Raw parameterized query, for tooling and tests. Application code uses `db` with the sql tag. */
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs multi-statement scripts plus follow-up queries in a single transaction (migrations). */
  scriptTransaction(fn: (s: ScriptRunner) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

// int8 fits safely in a JS number for every amount we store (max ₹1 crore in paise).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
const INT8_OID = 20;
const TIMESTAMPTZ_OID = 1184;

export async function rows<T>(ex: Executor, query: SQL): Promise<T[]> {
  // Both drivers return `{ rows, fields }`; their result types differ, so we normalise here.
  const res: unknown = await ex.execute(query);
  const { rows: out, fields = [] } = res as { rows: Record<string, unknown>[]; fields?: { name: string; dataTypeID: number }[] };
  // Drizzle's raw execute leaves timestamptz as text on both drivers; callers get Date, as with the pool.
  const stamps = fields.filter((f) => f.dataTypeID === TIMESTAMPTZ_OID).map((f) => f.name);
  for (const r of stamps.length ? out : []) {
    for (const k of stamps) if (typeof r[k] === 'string') r[k] = new Date(r[k]);
  }
  return out as T[];
}

export async function one<T>(ex: Executor, query: SQL): Promise<T | undefined> {
  return (await rows<T>(ex, query))[0];
}

export async function inTransaction<T>(ex: Executor, fn: (tx: Executor) => Promise<T>): Promise<T> {
  return ex.transaction((tx) => fn(tx as unknown as Executor));
}

export interface PostgresOptions {
  url: string;
  poolMax?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

export function createPostgresDatabase(opts: PostgresOptions): Database {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolMax ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: opts.applicationName ?? 'agentbazaar-api',
  });
  // An idle client error must not crash the process; the pool replaces the client.
  pool.on('error', (err) => console.error('postgres pool error', err.message));
  const db = drizzlePg({ client: pool, casing: 'snake_case' }) as unknown as Executor;
  return {
    driver: 'postgres',
    db,
    async query<T>(text: string, params: unknown[] = []) {
      return (await pool.query(text, params)).rows as T[];
    },
    async scriptTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await fn({
          exec: async (s) => void (await client.query(s)),
          query: async <T>(t: string, p: unknown[] = []) => (await client.query(t, p)).rows as T[],
        });
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  const client = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    extensions: { ltree, pg_trgm, vector },
    parsers: { [INT8_OID]: (v: string) => Number(v) },
  });
  const db = drizzlePglite({ client, casing: 'snake_case' }) as unknown as Executor;
  return {
    driver: 'pglite',
    db,
    async query<T>(text: string, params: unknown[] = []) {
      return (await client.query<T>(text, params)).rows;
    },
    async scriptTransaction(fn) {
      await client.transaction(async (tx) => {
        await fn({
          exec: async (s) => void (await tx.exec(s)),
          query: async <T>(t: string, p: unknown[] = []) => (await tx.query<T>(t, p)).rows,
        });
      });
    },
    close: () => client.close(),
  };
}
