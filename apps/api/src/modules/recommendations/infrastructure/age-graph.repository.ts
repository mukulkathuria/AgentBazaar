import { sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import type { EdgeKey, GraphRepository, RelatedProduct, SetupItem } from '../application/graph-repository.js';
import type { EdgeKind } from '../domain/graph.js';
import { rankRelated, rankSetup, SqlGraphRepository } from './sql-graph.repository.js';

/*
 * Apache AGE: openCypher inside the same Postgres. The graph `catalog` mirrors product_edges, which stays the source
 * of truth: a vertex per product and, because every relation is symmetric and AGE plans an undirected pattern as a
 * scan of every edge, a directed edge each way per related pair, carrying the pair's larger weight.
 * AGE resolves its operators through search_path, so each statement runs in a transaction that puts ag_catalog first
 * with set_config(..., true): transaction-local, which PgBouncer's transaction pooling keeps.
 * Cypher text is fixed in this file; values travel only in the bound agtype map (cypher()'s third argument).
 */
const GRAPH = 'catalog';
const KINDS: readonly EdgeKind[] = ['compatible_with', 'bought_together', 'alternative_of'];
const ZERO = '00000000-0000-0000-0000-000000000000';
const BATCH = 1000;

const RELATED =
  'MATCH (p:product)-[e]->(o:product) WHERE p.id = $id AND label(e) IN $kinds RETURN o.id, label(e), e.weight';
const SETUP =
  'MATCH (p:product)-[c:compatible_with]->(x:product)-[t:bought_together]->(y:product) ' +
  'WHERE p.id = $id AND y <> p AND NOT EXISTS((p)-[]->(y)) RETURN y.id, c.weight, t.weight';
const merge = (kind: EdgeKind) =>
  `UNWIND $edges AS e MATCH (a:product), (b:product) WHERE a.id = e.a AND b.id = e.b MERGE (a)-[r:${kind}]->(b) SET r.weight = e.w`;

const cypher = (query: string, params: object, columns: string): SQL =>
  sql`ag_catalog.cypher(${sql.raw(`'${GRAPH}', $$ ${query} $$`)}, ${JSON.stringify(params)}) AS (${sql.raw(columns)})`;

const AGE_PATH = sql`set_config('search_path', 'ag_catalog, ' || current_setting('search_path'), true)`;

/** Runs `fn` with ag_catalog first on the search path, then restores the caller's path for the rest of its transaction. */
async function withAgePath<T>(tx: Executor, fn: () => Promise<T>): Promise<T> {
  const { prev } = (await one<{ prev: string }>(
    tx,
    sql`SELECT prev, set_config('search_path', 'ag_catalog, ' || prev, true)
        FROM (SELECT current_setting('search_path') AS prev OFFSET 0) s`,
  ))!;
  const out = await fn();
  await tx.execute(sql`SELECT set_config('search_path', ${prev}, true)`);
  return out;
}

/** Mirrors the related pairs behind `edges` from product_edges into the graph, inside `tx`. */
async function syncEdges(tx: Executor, edges: readonly EdgeKey[]): Promise<void> {
  if (!edges.length) return;
  const [as, bs, kinds] = [edges.map((e) => e.a), edges.map((e) => e.b), edges.map((e) => e.kind)];
  const pairs = await rows<{ a: string; b: string; kind: EdgeKind; w: number }>(
    tx,
    sql`SELECT p.a::text AS a, p.b::text AS b, p.kind, max(e.weight)::float8 AS w
        FROM unnest(${pgArray(as, 'uuid')}, ${pgArray(bs, 'uuid')}, ${pgArray(kinds, 'text')}) AS p(a, b, kind)
        JOIN product_edges e ON e.kind = p.kind AND ((e.a_id = p.a AND e.b_id = p.b) OR (e.a_id = p.b AND e.b_id = p.a))
        GROUP BY p.a, p.b, p.kind`,
  );
  await withAgePath(tx, async () => {
    // Plain SQL so ON CONFLICT on the unique id index makes concurrent syncs safe; Cypher MERGE would race.
    const ids = pgArray([...new Set(pairs.flatMap((p) => [p.a, p.b]))], 'text');
    await tx.execute(sql`INSERT INTO ${sql.raw(GRAPH)}.product (properties)
                         SELECT ag_catalog.agtype_build_map('id', id) FROM unnest(${ids}) AS id ON CONFLICT DO NOTHING`);
    for (const kind of KINDS) {
      const directed = pairs
        .filter((p) => p.kind === kind)
        .flatMap(({ a, b, w }) => [
          { a, b, w },
          { a: b, b: a, w },
        ]);
      for (let i = 0; i < directed.length; i += BATCH) {
        const edges = directed.slice(i, i + BATCH);
        await tx.execute(sql`SELECT * FROM ${cypher(merge(kind), { edges }, 'r ag_catalog.agtype')}`);
      }
    }
  });
}

async function backfill(tx: Executor): Promise<number> {
  let done = 0;
  for (let last = ZERO; ;) {
    const page = await rows<EdgeKey & { id: string }>(
      tx,
      sql`SELECT id, a_id AS a, b_id AS b, kind FROM product_edges WHERE id > ${last} ORDER BY id LIMIT 5000`,
    );
    if (!page.length) return done;
    await syncEdges(tx, page);
    done += page.length;
    last = page.at(-1)!.id;
  }
}

async function createGraph(tx: Executor): Promise<void> {
  await tx.execute(sql`SELECT ag_catalog.create_graph(${GRAPH})`);
  await tx.execute(sql`SELECT ag_catalog.create_vlabel(${GRAPH}, 'product')`);
  for (const kind of KINDS) await tx.execute(sql`SELECT ag_catalog.create_elabel(${GRAPH}, ${kind})`);
  // The index behind `p.id = $id` lookups; unique, so a product is never two vertices.
  await tx.execute(
    sql.raw(`CREATE UNIQUE INDEX product_id_idx ON ${GRAPH}.product
             (ag_catalog.agtype_access_operator(VARIADIC ARRAY[properties, '"id"'::ag_catalog.agtype]))`),
  );
}

/** True when the server has AGE and preloads it, so every pooled connection can run Cypher without LOAD. */
export async function hasAge(db: Executor): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    db,
    sql`SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'age')
          AND concat_ws(',', current_setting('shared_preload_libraries'), current_setting('session_preload_libraries')) ~ '\\mage\\M' AS ok`,
  ).catch(() => undefined); // e.g. a role that may not read shared_preload_libraries
  return r?.ok === true;
}

/**
 * Creates the extension and the graph if missing (`rebuild` drops the graph first), then fills an empty graph from
 * product_edges. One transaction under an advisory lock, so replicas starting together do it once and a failure
 * leaves nothing behind. Returns the product_edges rows mirrored.
 */
export async function installGraph(db: Executor, rebuild = false): Promise<number> {
  return inTransaction(db, async (tx) => {
    // Another replica may be backfilling: wait for it rather than time out on the lock.
    await tx.execute(sql`SELECT set_config('statement_timeout', '10min', true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agentbazaar.product_graph'))`);
    await tx.execute(sql`CREATE EXTENSION IF NOT EXISTS age`);
    return withAgePath(tx, async () => {
      const g = await one<{ exists: boolean }>(
        tx,
        sql`SELECT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${GRAPH}) AS exists`,
      );
      if (g?.exists && rebuild) await tx.execute(sql`SELECT ag_catalog.drop_graph(${GRAPH}, true)`);
      if (!g?.exists || rebuild) await createGraph(tx);
      const empty = await one<{ empty: boolean }>(
        tx,
        sql`SELECT NOT EXISTS (SELECT 1 FROM ${sql.raw(GRAPH)}.product) AS empty`,
      );
      return empty?.empty ? backfill(tx) : 0;
    });
  });
}

/** `cli graph rebuild`: the graph rebuilt from product_edges; null when the server has no AGE. */
export async function rebuildGraph(db: Executor): Promise<number | null> {
  return (await hasAge(db)) ? installGraph(db, true) : null;
}

export class AgeGraphRepository implements GraphRepository {
  readonly engine = 'age';

  constructor(private readonly db: Executor) {}

  related(productId: string, kinds: readonly EdgeKind[], limit: number): Promise<RelatedProduct[]> {
    const edges = sql`SELECT (id::text)::uuid AS other, kind::text AS kind, weight::float8 AS weight
                      FROM ${cypher(RELATED, { id: productId, kinds }, 'id ag_catalog.agtype, kind ag_catalog.agtype, weight ag_catalog.agtype')}`;
    return this.read(rankRelated(edges, pgArray(kinds, 'text'), limit));
  }

  completeTheSetup(productId: string, limit: number): Promise<SetupItem[]> {
    const paths = sql`SELECT (y::text)::uuid AS y, cw::float8 AS cw, tw::float8 AS tw
                      FROM ${cypher(SETUP, { id: productId }, 'y ag_catalog.agtype, cw ag_catalog.agtype, tw ag_catalog.agtype')}`;
    return this.read(rankSetup(paths, limit));
  }

  upsertEdges(tx: Executor, edges: readonly EdgeKey[]): Promise<void> {
    return syncEdges(tx, edges);
  }

  private read<T>(query: SQL): Promise<T[]> {
    return inTransaction(this.db, async (tx) => {
      // JIT costs more than these index lookups whenever AGE's row estimates run high.
      await tx.execute(sql`SELECT ${AGE_PATH}, set_config('jit', 'off', true)`);
      return rows<T>(tx, query);
    });
  }
}

/**
 * AGE when the server has it and the graph installs and answers, else joins. The graph is installed on `db`;
 * lookups run on `reads` (a replica in growth). Any failure degrades to joins instead of failing requests; once the
 * graph is installed, writes keep it in sync even when this process reads with joins.
 */
export async function createGraphRepository(
  db: Executor,
  reads: Executor = db,
  log?: Pick<Logger, 'warn'>,
): Promise<GraphRepository> {
  if (!(await hasAge(db))) return new SqlGraphRepository(reads);
  try {
    await installGraph(db);
  } catch (err) {
    log?.warn({ err }, 'Apache AGE is available but the product graph could not be installed; using joins');
    return new SqlGraphRepository(reads);
  }
  const age = new AgeGraphRepository(reads);
  try {
    await age.related(ZERO, ['compatible_with'], 1);
    await age.completeTheSetup(ZERO, 1);
    return age;
  } catch (err) {
    log?.warn(
      { err },
      'Product graph queries failed on Apache AGE; reading with joins, keeping the graph in sync',
    );
    return new SqlGraphRepository(reads, syncEdges);
  }
}
