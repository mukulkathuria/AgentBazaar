import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.js';

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {}

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { version: name.slice(0, 4), name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Applies pending migrations forward, one transaction each, under an advisory lock so that
 * several instances booting together cannot race. Refuses to run if an applied file changed.
 */
export async function migrate(database: Database, migrations: Migration[]): Promise<string[]> {
  const versions = new Set<string>();
  for (const m of migrations) {
    if (versions.has(m.version)) throw new MigrationError(`Duplicate migration version ${m.version}`);
    versions.add(m.version);
  }
  await database.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const applied: string[] = [];
  for (const m of migrations) {
    await database.scriptTransaction(async (s) => {
      await s.query(`SELECT pg_advisory_xact_lock(hashtext('agentbazaar.migrations'))`);
      const [existing] = await s.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [m.version],
      );
      if (existing) {
        if (existing.checksum !== m.checksum) {
          throw new MigrationError(`Migration ${m.name} was modified after it was applied. Add a new migration instead.`);
        }
        return;
      }
      await s.exec(m.sql);
      await s.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
        m.version,
        m.name,
        m.checksum,
      ]);
      applied.push(m.name);
    });
  }
  return applied;
}
