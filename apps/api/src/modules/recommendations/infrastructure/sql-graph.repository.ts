import { sql, type SQL } from 'drizzle-orm';
import { rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import type { EdgeKey, GraphRepository, RelatedProduct, SetupItem } from '../application/graph-repository.js';
import type { EdgeKind } from '../domain/graph.js';

/*
 * Ranking shared by both engines, so they agree by construction; only where the edges come from differs.
 * `edges` yields (other uuid, kind text, weight); `paths` yields one row per P–X–Y path (y uuid, cw, tw). Scores
 * are summed as numeric, so the result does not depend on the order the rows arrive in.
 */
export const rankRelated = (edges: SQL, k: SQL, limit: number): SQL =>
  sql`SELECT other AS "productId", kind, max(weight)::float8 AS weight FROM (${edges}) e
      GROUP BY other, kind ORDER BY array_position(${k}, kind), weight DESC, other LIMIT ${limit}`;

export const rankSetup = (paths: SQL, limit: number): SQL =>
  sql`SELECT y AS "productId", sum((cw::float8 * tw::float8)::numeric)::float8 AS score FROM (${paths}) p
      GROUP BY y ORDER BY score DESC, y LIMIT ${limit}`;

type Sync = GraphRepository['upsertEdges'];

/** Plain joins on product_edges; works on every Postgres and on PGlite. */
export class SqlGraphRepository implements GraphRepository {
  readonly engine = 'sql';

  /** `sync` keeps an installed AGE graph current when this process reads with joins anyway. */
  constructor(
    private readonly db: Executor,
    private readonly sync?: Sync,
  ) {}

  async related(productId: string, kinds: readonly EdgeKind[], limit: number): Promise<RelatedProduct[]> {
    const k = pgArray(kinds, 'text');
    const edges = sql`SELECT b_id AS other, kind, weight FROM product_edges WHERE a_id = ${productId} AND kind = ANY(${k})
                      UNION ALL
                      SELECT a_id, kind, weight FROM product_edges WHERE b_id = ${productId} AND kind = ANY(${k})`;
    return rows<RelatedProduct>(this.db, rankRelated(edges, k, limit));
  }

  async completeTheSetup(productId: string, limit: number): Promise<SetupItem[]> {
    const paths = sql`
      WITH n AS (SELECT b_id AS other, kind, weight FROM product_edges WHERE a_id = ${productId}
                 UNION ALL SELECT a_id, kind, weight FROM product_edges WHERE b_id = ${productId}),
      c AS (SELECT other AS x, max(weight) AS cw FROM n WHERE kind = 'compatible_with' GROUP BY other),
      t AS (SELECT c.x, c.cw, e.b_id AS y, e.weight FROM c JOIN product_edges e ON e.a_id = c.x AND e.kind = 'bought_together'
            UNION ALL SELECT c.x, c.cw, e.a_id, e.weight FROM c JOIN product_edges e ON e.b_id = c.x AND e.kind = 'bought_together')
      SELECT y, cw, max(weight) AS tw FROM t
      WHERE y <> ${productId} AND y NOT IN (SELECT other FROM n) GROUP BY x, y, cw`;
    return rows<SetupItem>(this.db, rankSetup(paths, limit));
  }

  async upsertEdges(tx: Executor, edges: readonly EdgeKey[]): Promise<void> {
    await this.sync?.(tx, edges);
  }
}
