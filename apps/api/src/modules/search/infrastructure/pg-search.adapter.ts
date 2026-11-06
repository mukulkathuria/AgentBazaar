import type { PriceBand, ProductSummary, SearchQuery, SearchResult } from '@agentbazaar/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { inTransaction, one, type Executor } from '../../../shared/db/database.js';
import type { SearchDocument, SearchPort } from '../application/ports.js';
import type { EmbeddingsPort } from '../domain/embeddings.js';
import { MIN_VECTOR_SIMILARITY, RRF_K } from '../domain/ranking.js';

/** search_documents.embedding is vector(256). */
const EMBEDDING_DIM = 256;
/** pg_trgm word similarity a typo needs ("keybaord" scores 0.44 against "keyboard"; default is 0.6). */
const WORD_SIMILARITY = 0.4;
const CATEGORY_PATH = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

interface Facet {
  value: string;
  count: number;
}

interface ItemRow {
  id: string;
  slug: string;
  name: string;
  brand: string;
  category_path: string;
  band: PriceBand;
  min_price_paise: number;
  max_price_paise: number;
  in_stock: boolean;
  image: string | null;
  customizable: boolean;
  default_sku: string;
}

interface ResultRow {
  total: number;
  brands: Facet[];
  categories: Facet[];
  items: ItemRow[];
}

const HIT_COLUMNS = sql`d.product_id, d.slug, d.name, d.brand, d.category_path, d.band, d.min_price_paise, d.max_price_paise,
  d.in_stock, d.image, d.customizable, d.default_sku, d.popularity`;

/**
 * Lite search over the `search_documents` read model: full text (simple + english configs),
 * trigram word similarity for typos and pgvector cosine distance, fused with Reciprocal Rank
 * Fusion. Every leg is exact (no top-k cut-off), so `total` and the facets cover the whole match
 * set. shortcut: the vector leg scans the filtered rows, fine to ~50k products; beyond that use
 * the growth/scale engines or switch the leg to the HNSW index.
 */
export class PgSearchAdapter implements SearchPort {
  constructor(
    private readonly db: Executor,
    private readonly embeddings: EmbeddingsPort,
  ) {}

  async upsert(docs: readonly SearchDocument[], embeddings: readonly (readonly number[])[], ex: Executor = this.db): Promise<void> {
    if (!docs.length) return;
    const values = docs.map(
      (doc, i) => sql`(${doc.productId}, ${doc.slug}, ${doc.name}, ${doc.brand}, ${doc.categoryPath}::ltree, ${doc.categoryName},
        ${doc.description}, ${doc.skus.join(' ')}, ${doc.defaultSku}, ${doc.band}, ${doc.minPricePaise}, ${doc.maxPricePaise},
        ${doc.inStock}, ${doc.image}, ${doc.customizable}, ${vectorParam(embeddings[i] ?? [])})`,
    );
    await ex.execute(sql`
      INSERT INTO search_documents (product_id, slug, name, brand, category_path, category_name, description, sku_text, default_sku,
                                    band, min_price_paise, max_price_paise, in_stock, image, customizable, embedding)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (product_id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, brand = EXCLUDED.brand,
        category_path = EXCLUDED.category_path, category_name = EXCLUDED.category_name, description = EXCLUDED.description,
        sku_text = EXCLUDED.sku_text, default_sku = EXCLUDED.default_sku, band = EXCLUDED.band,
        min_price_paise = EXCLUDED.min_price_paise, max_price_paise = EXCLUDED.max_price_paise, in_stock = EXCLUDED.in_stock,
        image = EXCLUDED.image, customizable = EXCLUDED.customizable, embedding = EXCLUDED.embedding, updated_at = now()`);
  }

  async remove(productId: string, ex: Executor = this.db): Promise<void> {
    await ex.execute(sql`DELETE FROM search_documents WHERE product_id = ${productId}`);
  }

  async count(): Promise<number> {
    return (await one<{ n: number }>(this.db, sql`SELECT count(*)::int AS n FROM search_documents`))?.n ?? 0;
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const started = performance.now();
    const where = filters(query);
    const q = query.q.trim();
    let row: ResultRow | undefined;
    if (!q) {
      // Browse: everything matching the filters, most popular first.
      row = await one<ResultRow>(this.db, resultSql(sql`SELECT ${HIT_COLUMNS}, 0::float8 AS score FROM search_documents d WHERE ${where}`, query));
    } else {
      const [vector] = await this.embeddings.embed([q]);
      const statement = resultSql(hybridHits(q, where, vector ?? []), query);
      row = await inTransaction(this.db, async (tx) => {
        // Transaction-local, so pooled connections keep the server default.
        await tx.execute(sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(WORD_SIMILARITY)}, true)`);
        return one<ResultRow>(tx, statement);
      });
    }
    return {
      items: (row?.items ?? []).map(toSummary),
      total: row?.total ?? 0,
      facets: { brands: row?.brands ?? [], categories: row?.categories ?? [] },
      tookMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }
}

/** Price filters keep products with a variant in range: [min, max] must overlap the request. */
function filters(q: SearchQuery): SQL {
  const conds: SQL[] = [sql`true`];
  if (q.category) {
    const path = q.category.toLowerCase();
    conds.push(CATEGORY_PATH.test(path) ? sql`d.category_path <@ ${path}::ltree` : sql`false`);
  }
  if (q.brand) conds.push(sql`lower(d.brand) = lower(${q.brand})`);
  if (q.minPricePaise !== undefined) conds.push(sql`d.max_price_paise >= ${q.minPricePaise}`);
  if (q.maxPricePaise !== undefined) conds.push(sql`d.min_price_paise <= ${q.maxPricePaise}`);
  if (q.inStockOnly) conds.push(sql`d.in_stock`);
  return sql.join(conds, sql` AND `);
}

function hybridHits(q: string, where: SQL, vector: readonly number[]): SQL {
  const legs = [
    sql`SELECT d.product_id, row_number() OVER (ORDER BY ts_rank_cd(d.tsv, t.q) DESC, d.product_id) AS r
        FROM search_documents d, (SELECT websearch_to_tsquery('simple', ${q}) || websearch_to_tsquery('english', ${q}) AS q) t
        WHERE ${where} AND d.tsv @@ t.q`,
    sql`SELECT d.product_id, row_number() OVER (ORDER BY word_similarity(${q}, d.trgm_text) DESC, d.product_id) AS r
        FROM search_documents d WHERE ${where} AND ${q} <% d.trgm_text`,
  ];
  if (vector.some((x) => x !== 0)) {
    legs.push(sql`SELECT product_id, row_number() OVER (ORDER BY dist, product_id) AS r
        FROM (SELECT d.product_id, d.embedding <=> ${vectorParam(vector)} AS dist FROM search_documents d WHERE ${where}) v
        WHERE dist <= ${1 - MIN_VECTOR_SIMILARITY}`);
  }
  return sql`SELECT ${HIT_COLUMNS}, f.score FROM (
      SELECT product_id, sum(1.0::float8 / (${RRF_K} + r)) AS score
      FROM (${sql.join(
        legs.map((leg) => sql`(${leg})`),
        sql` UNION ALL `,
      )}) legs GROUP BY product_id
    ) f JOIN search_documents d USING (product_id)`;
}

/** One round trip: total, facets and the requested page, all over the same materialised hit set. */
function resultSql(hits: SQL, query: SearchQuery): SQL {
  return sql`WITH hits AS MATERIALIZED (${hits})
    SELECT (SELECT count(*)::int FROM hits) AS total,
      (SELECT coalesce(json_agg(json_build_object('value', value, 'count', n) ORDER BY n DESC, value), '[]'::json)
         FROM (SELECT brand AS value, count(*)::int AS n FROM hits GROUP BY brand ORDER BY n DESC, brand LIMIT 20) b) AS brands,
      (SELECT coalesce(json_agg(json_build_object('value', value, 'count', n) ORDER BY n DESC, value), '[]'::json)
         FROM (SELECT subpath(category_path, 0, 1)::text AS value, count(*)::int AS n FROM hits
               GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20) c) AS categories,
      (SELECT coalesce(json_agg(p ORDER BY p.score DESC, p.popularity DESC, p.name, p.id), '[]'::json) FROM (
         SELECT score, popularity, product_id AS id, slug, name, brand, category_path::text AS category_path, band, min_price_paise,
                max_price_paise, in_stock, image, customizable, default_sku
         FROM hits ORDER BY score DESC, popularity DESC, name, product_id LIMIT ${query.limit} OFFSET ${query.offset}) p) AS items`;
}

function vectorParam(v: readonly number[]): SQL {
  if (v.length !== EMBEDDING_DIM) throw new Error(`Search embeddings need ${EMBEDDING_DIM} dimensions, got ${v.length}`);
  return v.some((x) => x !== 0) ? sql`${`[${v.join(',')}]`}::vector` : sql`NULL`;
}

const toSummary = (r: ItemRow): ProductSummary => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  brand: r.brand,
  categoryPath: r.category_path,
  band: r.band,
  minPricePaise: r.min_price_paise,
  maxPricePaise: r.max_price_paise,
  inStock: r.in_stock,
  image: r.image,
  customizable: r.customizable,
  defaultSku: r.default_sku,
});
