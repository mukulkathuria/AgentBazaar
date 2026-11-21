import { sql } from 'drizzle-orm';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import type { GraphRepository, RelatedProduct } from '../application/graph-repository.js';
import type { EdgeKind } from '../domain/graph.js';
import { SqlGraphRepository } from './sql-graph.repository.js';

/*
 * SQL/PGQ did not ship in PostgreSQL 19.0: its grammar has no GRAPH_TABLE (checked on 19.0 on
 * 2026-11-21), so detection is by keyword, not version, and 19 and PGlite use SqlGraphRepository.
 * This path turns on by itself on a server that has it; the integration suite then runs on it.
 * Element labels are static per table, so the edge kind is a property filtered in SQL rather than
 * a label (`IS related` + kind instead of `IS compatible_with`).
 */
const CREATE_GRAPH = sql.raw(`CREATE PROPERTY GRAPH catalog_graph
  VERTEX TABLES (products KEY (id) LABEL product PROPERTIES (id))
  EDGE TABLES (product_edges KEY (id)
    SOURCE KEY (a_id) REFERENCES products (id)
    DESTINATION KEY (b_id) REFERENCES products (id)
    LABEL related PROPERTIES (kind, weight))`);

export class PgqGraphRepository implements GraphRepository {
  readonly engine = 'pgq';

  constructor(private readonly db: Executor) {}

  async related(productId: string, kinds: readonly EdgeKind[], limit: number): Promise<RelatedProduct[]> {
    const k = pgArray(kinds, 'text');
    return rows<RelatedProduct>(
      this.db,
      sql`SELECT id AS "productId", kind, max(weight)::float8 AS weight FROM (
            SELECT * FROM GRAPH_TABLE (catalog_graph
              MATCH (a IS product WHERE a.id = ${productId})-[e IS related]->(b IS product)
              COLUMNS (b.id AS id, e.kind AS kind, e.weight AS weight))
            UNION ALL
            SELECT * FROM GRAPH_TABLE (catalog_graph
              MATCH (b IS product)-[e IS related]->(a IS product WHERE a.id = ${productId})
              COLUMNS (b.id AS id, e.kind AS kind, e.weight AS weight))
          ) g WHERE kind = ANY(${k}) GROUP BY id, kind
          ORDER BY array_position(${k}, kind), weight DESC, id LIMIT ${limit}`,
    );
  }
}

/** True when the server's grammar has SQL/PGQ (the GRAPH_TABLE keyword). */
export async function hasSqlPgq(db: Executor): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    db,
    sql`SELECT EXISTS (SELECT 1 FROM pg_get_keywords() WHERE word = 'graph_table') AS ok`,
  );
  return r?.ok === true;
}

/**
 * (Re)creates the property graph when the server supports SQL/PGQ. Runs in its own transaction
 * (a savepoint when called inside one), so a failed CREATE leaves nothing behind.
 */
export async function installPropertyGraph(db: Executor): Promise<boolean> {
  if (!(await hasSqlPgq(db))) return false;
  try {
    await inTransaction(db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agentbazaar.catalog_graph'))`);
      await tx.execute(sql`DROP PROPERTY GRAPH IF EXISTS catalog_graph`);
      await tx.execute(CREATE_GRAPH);
    });
    return true;
  } catch {
    return false;
  }
}

/** The graph is (re)created on `db`; lookups run on `reads` (a replica in growth). */
export async function createGraphRepository(db: Executor, reads: Executor = db): Promise<GraphRepository> {
  if (await installPropertyGraph(db)) {
    const pgq = new PgqGraphRepository(reads);
    // Probe the exact query once: a PGQ dialect surprise then degrades to joins instead of failing requests.
    const works = await pgq.related('00000000-0000-0000-0000-000000000000', ['compatible_with'], 1).then(
      () => true,
      () => false,
    );
    if (works) return pgq;
  }
  return new SqlGraphRepository(reads);
}
