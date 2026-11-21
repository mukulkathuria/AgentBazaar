import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../shared/db/database.js';
import { createGraphRepository, hasAge } from './age-graph.repository.js';

const dialect = new PgDialect();
const P = '0d1d2c3b-4a59-4687-8796-a5b4c3d2e1f0';
const Q = '1d1d2c3b-4a59-4687-8796-a5b4c3d2e1f0';

/** Canned answers for the statements detection and sync issue; everything else returns no rows. */
function answer(text: string, age: boolean): Record<string, unknown>[] {
  if (text.includes('pg_available_extensions')) return [{ ok: age }];
  if (text.includes('AS prev')) return [{ prev: '"$user", public' }];
  if (text.includes('ag_catalog.ag_graph')) return [{ exists: false }];
  if (text.includes('AS empty')) return [{ empty: true }];
  if (text.includes('max(e.weight)::float8 AS w')) return [{ a: P, b: Q, kind: 'bought_together', w: 2 }];
  return [];
}

/**
 * Stands in for a server with or without Apache AGE. `fail` makes statements containing that text throw, so each
 * step of detection can be exercised without an AGE server.
 */
function fakeServer(age: boolean, fail?: string) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = {
    async execute(query: SQL) {
      const q = dialect.sqlToQuery(query);
      statements.push(q);
      if (fail && q.sql.includes(fail)) throw new Error(`error near ${fail}`);
      return { rows: answer(q.sql, age) };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) {
      return fn(db);
    },
  };
  const ran = (text: string) => statements.some((s) => s.sql.includes(text));
  return { db: db as unknown as Executor, statements, ran };
}

describe('@lite Apache AGE detection and fallback', () => {
  it('never attempts DDL on a server without AGE (PGlite, RDS, Aurora)', async () => {
    const s = fakeServer(false);
    expect(await hasAge(s.db)).toBe(false);
    expect((await createGraphRepository(s.db)).engine).toBe('sql');
    expect(s.ran('CREATE EXTENSION')).toBe(false);
  });

  it('treats an unreadable preload setting as no AGE', async () => {
    expect(await hasAge(fakeServer(true, 'pg_available_extensions').db)).toBe(false);
  });

  it('installs the extension and graph, then reads with Cypher', async () => {
    const s = fakeServer(true);
    const repo = await createGraphRepository(s.db);
    expect(repo.engine).toBe('age');
    for (const step of [
      'CREATE EXTENSION IF NOT EXISTS age',
      'ag_catalog.create_graph',
      'CREATE UNIQUE INDEX product_id_idx',
    ])
      expect(s.ran(step)).toBe(true);
    expect(s.ran("ag_catalog.cypher('catalog', $$ MATCH (p:product)-[e]->(o:product)")).toBe(true);
  });

  it('binds values in the agtype map and never splices them into Cypher', async () => {
    const s = fakeServer(true);
    const repo = await createGraphRepository(s.db);
    const hostile = "x' }) MATCH (n) DETACH DELETE n //";
    await repo.related(hostile, ['compatible_with'], 5);
    await repo.completeTheSetup(hostile, 5);
    const reads = s.statements.filter(
      (q) => q.sql.includes('ag_catalog.cypher') && q.params.some((p) => String(p).includes('DETACH')),
    );
    expect(reads).toHaveLength(2);
    for (const q of reads) {
      expect(q.sql).not.toContain('DETACH');
      expect(JSON.parse(q.params.find((p) => String(p).includes('DETACH')) as string)).toMatchObject({
        id: hostile,
      });
    }
  });

  it('falls back to joins, with no graph writes, when installing fails', async () => {
    const s = fakeServer(true, 'ag_catalog.create_graph');
    const repo = await createGraphRepository(s.db);
    expect(repo.engine).toBe('sql');
    await repo.upsertEdges(s.db, [{ a: P, b: Q, kind: 'bought_together' }]);
    expect(s.ran('MERGE')).toBe(false);
  });

  it('reads with joins but keeps the installed graph in sync when the Cypher probe fails', async () => {
    const s = fakeServer(true, 'MATCH (p:product)');
    const repo = await createGraphRepository(s.db);
    expect(repo.engine).toBe('sql');
    await repo.upsertEdges(s.db, [{ a: P, b: Q, kind: 'bought_together' }]);
    const merge = s.statements.find((q) => q.sql.includes('MERGE (a)-[r:bought_together]->(b)'));
    // One directed edge each way, carrying the pair's weight from product_edges.
    expect(JSON.parse(merge!.params[0] as string)).toEqual({
      edges: [
        { a: P, b: Q, w: 2 },
        { a: Q, b: P, w: 2 },
      ],
    });
  });
});
