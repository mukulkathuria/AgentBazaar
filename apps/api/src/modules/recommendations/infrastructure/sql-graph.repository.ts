import { sql } from 'drizzle-orm';
import { rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import type { GraphRepository, RelatedProduct } from '../application/graph-repository.js';
import type { EdgeKind } from '../domain/graph.js';

/** Plain joins on product_edges; works on every Postgres and on PGlite. */
export class SqlGraphRepository implements GraphRepository {
  readonly engine = 'sql';

  constructor(private readonly db: Executor) {}

  async related(productId: string, kinds: readonly EdgeKind[], limit: number): Promise<RelatedProduct[]> {
    const k = pgArray(kinds, 'text');
    return rows<RelatedProduct>(
      this.db,
      sql`SELECT other AS "productId", kind, max(weight)::float8 AS weight FROM (
            SELECT b_id AS other, kind, weight FROM product_edges WHERE a_id = ${productId} AND kind = ANY(${k})
            UNION ALL
            SELECT a_id, kind, weight FROM product_edges WHERE b_id = ${productId} AND kind = ANY(${k})
          ) e GROUP BY other, kind
          ORDER BY array_position(${k}, kind), weight DESC, other LIMIT ${limit}`,
    );
  }
}
