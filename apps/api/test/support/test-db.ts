import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteDatabase, createPostgresDatabase, type Database } from '../../src/shared/db/database.js';
import { loadMigrations, migrate } from '../../src/shared/db/migrator.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface TestDb {
  database: Database;
  url: string | null;
  cleanup(): Promise<void>;
}

/**
 * PGlite in memory by default (no setup needed). When TEST_DATABASE_URL points at a real
 * Postgres, each test file gets its own freshly migrated database that is dropped afterwards.
 */
export async function createTestDb(opts: { poolMax?: number; statementTimeoutMs?: number } = {}): Promise<TestDb> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const database = await createPgliteDatabase();
    await migrate(database, loadMigrations(MIGRATIONS_DIR));
    // The app may already have closed it; closing twice is harmless here.
    return { database, url: null, cleanup: () => database.close().catch(() => undefined) };
  }
  const admin = createPostgresDatabase({ url: adminUrl, poolMax: 1 });
  const name = `ab_test_${randomUUID().replace(/-/g, '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const database = createPostgresDatabase({
    url: url.toString(),
    poolMax: opts.poolMax ?? 20,
    ...(opts.statementTimeoutMs ? { statementTimeoutMs: opts.statementTimeoutMs } : {}),
  });
  await migrate(database, loadMigrations(MIGRATIONS_DIR));
  return {
    database,
    url: url.toString(),
    async cleanup() {
      await database.close().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

export const usingRealPostgres = (): boolean => Boolean(process.env.TEST_DATABASE_URL);
