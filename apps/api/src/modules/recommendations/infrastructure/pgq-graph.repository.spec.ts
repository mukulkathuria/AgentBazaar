import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../shared/db/database.js';
import { createGraphRepository, installPropertyGraph } from './pgq-graph.repository.js';

const dialect = new PgDialect();

/**
 * Stands in for a server of the given version. `fail` makes statements containing that text throw,
 * so each step of detection can be exercised without PostgreSQL 19.
 */
function fakeServer(versionNum: number, fail?: string) {
  const statements: string[] = [];
  const db = {
    async execute(query: SQL) {
      const text = dialect.sqlToQuery(query).sql;
      statements.push(text);
      if (fail && text.includes(fail)) throw new Error(`syntax error near ${fail}`);
      return { rows: text.includes('server_version_num') ? [{ n: versionNum }] : [] };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      return fn(db);
    },
  };
  return { db: db as unknown as Executor, statements };
}

describe('@lite SQL/PGQ detection and fallback', () => {
  it('never attempts DDL before PostgreSQL 19', async () => {
    const s = fakeServer(180_006);
    expect(await installPropertyGraph(s.db)).toBe(false);
    expect((await createGraphRepository(s.db)).engine).toBe('sql');
    expect(s.statements.some((t) => t.includes('PROPERTY GRAPH'))).toBe(false);
  });

  it('uses SQL/PGQ when the graph is created and the query runs', async () => {
    const s = fakeServer(190_000);
    expect((await createGraphRepository(s.db)).engine).toBe('pgq');
    expect(s.statements.some((t) => t.includes('CREATE PROPERTY GRAPH catalog_graph'))).toBe(true);
    expect(s.statements.some((t) => t.includes('GRAPH_TABLE (catalog_graph'))).toBe(true);
  });

  it('falls back to joins when CREATE PROPERTY GRAPH fails', async () => {
    const s = fakeServer(190_000, 'CREATE PROPERTY GRAPH');
    expect(await installPropertyGraph(s.db)).toBe(false);
    expect((await createGraphRepository(s.db)).engine).toBe('sql');
  });

  it('falls back to joins when the graph exists but the GRAPH_TABLE query fails', async () => {
    const s = fakeServer(200_000, 'GRAPH_TABLE');
    expect((await createGraphRepository(s.db)).engine).toBe('sql');
  });
});
