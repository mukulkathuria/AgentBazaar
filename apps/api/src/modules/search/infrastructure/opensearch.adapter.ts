import type { SearchQuery, SearchResult } from '@agentbazaar/contracts';
import type { SearchDocument, SearchPort } from '../application/ports.js';
import type { EmbeddingsPort } from '../domain/embeddings.js';
import { MIN_VECTOR_SIMILARITY, reciprocalRankFusion } from '../domain/ranking.js';
import { type EngineDoc, facetList, fromEngineDoc, toEngineDoc, tookMs } from './engine-doc.js';
import { JsonHttp, type JsonHttpOptions, WRITE_TIMEOUT_MS } from './json-http.js';

export interface OpenSearchOptions extends JsonHttpOptions {
  url: string;
  qdrantUrl: string;
  index?: string;
  collection?: string;
}

interface Bucket {
  key: string;
  doc_count: number;
}
interface OsResponse {
  hits: { total: { value: number }; hits: { _id: string; _source: EngineDoc }[] };
  aggregations?: { brands?: { buckets: Bucket[] }; categories?: { buckets: Bucket[] } };
}
interface QdrantResponse {
  result: { id: string; score: number; payload: EngineDoc }[];
}
interface BulkResponse {
  errors: boolean;
  items: { index: { error?: { reason?: string } } }[];
}

const INDEX = {
  // A SKU is one lower-case token: split into parts, "CACAOL-CHOCOL-PC-SINGLE" made a chocolate match "pc cases".
  settings: { analysis: { analyzer: { sku: { type: 'custom', tokenizer: 'keyword', filter: ['lowercase'] } } } },
  mappings: {
    properties: {
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      brand: { type: 'keyword' },
      brand_lc: { type: 'keyword' },
      category_path: { type: 'keyword' },
      category_paths: { type: 'keyword' },
      category_top: { type: 'keyword' },
      category_name: { type: 'text' },
      description: { type: 'text' },
      skus: { type: 'text', analyzer: 'sku' },
      min_price_paise: { type: 'long' },
      max_price_paise: { type: 'long' },
      in_stock: { type: 'boolean' },
    },
  },
};

/** Qdrant payload indexes for every filtered field, so filtered vector searches need not scan. */
const PAYLOAD_INDEXES: [string, string][] = [
  ['category_paths', 'keyword'],
  ['brand_lc', 'keyword'],
  ['in_stock', 'bool'],
  ['min_price_paise', 'integer'],
  ['max_price_paise', 'integer'],
];

/** Our filters as an OpenSearch bool filter (price filters overlap the variant price range). */
export function openSearchFilter(q: SearchQuery): unknown[] {
  const f: unknown[] = [];
  if (q.category) f.push({ term: { category_paths: q.category.toLowerCase() } });
  if (q.brand) f.push({ term: { brand_lc: q.brand.toLowerCase() } });
  if (q.minPricePaise !== undefined) f.push({ range: { max_price_paise: { gte: q.minPricePaise } } });
  if (q.maxPricePaise !== undefined) f.push({ range: { min_price_paise: { lte: q.maxPricePaise } } });
  if (q.inStockOnly) f.push({ term: { in_stock: true } });
  return f;
}

/** The same filters for a Qdrant payload filter. */
export function qdrantFilter(q: SearchQuery): { must: unknown[] } {
  const must: unknown[] = [];
  if (q.category) must.push({ key: 'category_paths', match: { value: q.category.toLowerCase() } });
  if (q.brand) must.push({ key: 'brand_lc', match: { value: q.brand.toLowerCase() } });
  if (q.minPricePaise !== undefined) must.push({ key: 'max_price_paise', range: { gte: q.minPricePaise } });
  if (q.maxPricePaise !== undefined) must.push({ key: 'min_price_paise', range: { lte: q.maxPricePaise } });
  if (q.inStockOnly) must.push({ key: 'in_stock', match: { value: true } });
  return { must };
}

const buckets = (b?: { buckets: Bucket[] }) => facetList(Object.fromEntries((b?.buckets ?? []).map((x) => [x.key, x.doc_count])));

/**
 * Scale profile: OpenSearch for keywords (fuzzy), filters and facets, Qdrant for vectors, fused
 * with Reciprocal Rank Fusion. Verified against live engines by apps/api/test/services. Writes are
 * visible to searches after OpenSearch's next refresh (one second by default).
 */
export class OpenSearchAdapter implements SearchPort {
  private readonly os: JsonHttp;
  private readonly qdrant: JsonHttp;
  private readonly index: string;
  private readonly points: string;
  private ready: Promise<unknown> | undefined;

  constructor(
    opts: OpenSearchOptions,
    private readonly embeddings: EmbeddingsPort,
  ) {
    this.os = new JsonHttp('opensearch', opts.url, opts);
    this.qdrant = new JsonHttp('qdrant', opts.qdrantUrl, opts);
    this.index = `/${opts.index ?? 'products'}`;
    this.points = `/collections/${opts.collection ?? 'products'}`;
  }

  async upsert(docs: readonly SearchDocument[], embeddings: readonly (readonly number[])[]): Promise<void> {
    if (!docs.length) return;
    await this.ensure();
    const bodies = docs.map(toEngineDoc);
    const bulk = bodies.map((b) => `${JSON.stringify({ index: { _id: b.id } })}\n${JSON.stringify(b)}\n`).join('');
    // _bulk answers 200 even when some documents fail, so the per-item errors decide.
    const r = await this.os.request<BulkResponse>('POST', `${this.index}/_bulk`, bulk, [], WRITE_TIMEOUT_MS);
    const failed = r.items.filter((i) => i.index.error);
    if (r.errors) throw new Error(`opensearch rejected ${failed.length} of ${docs.length} documents: ${failed[0]?.index.error?.reason}`);
    const points = bodies.map((payload, i) => ({ id: payload.id, vector: embeddings[i], payload }));
    await this.qdrant.request('PUT', `${this.points}/points?wait=true`, { points }, [], WRITE_TIMEOUT_MS);
  }

  async remove(productId: string): Promise<void> {
    await this.os.request('DELETE', `${this.index}/_doc/${encodeURIComponent(productId)}`, undefined, [404], WRITE_TIMEOUT_MS);
    await this.qdrant.request('POST', `${this.points}/points/delete?wait=true`, { points: [productId] }, [], WRITE_TIMEOUT_MS);
  }

  async count(): Promise<number> {
    return (await this.os.request<{ count: number }>('GET', `${this.index}/_count`)).count;
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const started = performance.now();
    const q = query.q.trim();
    const filter = openSearchFilter(query);
    if (!q) {
      const r = await this.keywords({ from: query.offset, size: query.limit, sort: [{ 'name.keyword': 'asc' }], query: { bool: { filter } } });
      return this.result(r, r.hits.hits.map((h) => h._source), r.hits.total.value, started);
    }
    // Both engines rank deep enough to fill the requested page after fusion.
    const depth = Math.max(50, query.offset + query.limit);
    const [vector] = await this.embeddings.embed([q]);
    // Typos keep their first letter (prefix_length 1), which spares fuzzy matching most of the term dictionary.
    const match = { query: q, fields: ['name^3', 'category_name^2', 'skus', 'description'], fuzziness: 'AUTO', prefix_length: 1 };
    const [kw, vec] = await Promise.all([
      this.keywords({ from: 0, size: depth, query: { bool: { must: [{ multi_match: match }], filter } } }),
      this.qdrant.request<QdrantResponse>('POST', `${this.points}/points/search`, {
        vector,
        limit: depth,
        with_payload: true,
        score_threshold: MIN_VECTOR_SIMILARITY,
        filter: qdrantFilter(query),
      }),
    ]);
    const docs = new Map<string, EngineDoc>([
      ...vec.result.map((p): [string, EngineDoc] => [String(p.id), p.payload]),
      ...kw.hits.hits.map((h): [string, EngineDoc] => [h._id, h._source]),
    ]);
    // The keyword ranking counts twice, the balance of lite's two lexical legs (full text, trigram) to one vector leg.
    const keywordIds = kw.hits.hits.map((h) => h._id);
    const fused = reciprocalRankFusion([keywordIds, keywordIds, vec.result.map((p) => String(p.id))]);
    // An exact SKU (of any variant) is a lookup: that product goes first, as in the other engines.
    const sku = kw.hits.hits.find((h) => h._source.skus.includes(q.toUpperCase()))?._id;
    const ranked = sku ? [sku, ...fused.map((f) => f.id).filter((id) => id !== sku)] : fused.map((f) => f.id);
    const page = ranked.slice(query.offset, query.offset + query.limit).map((id) => docs.get(id)!);
    // shortcut: facets cover keyword matches only and total is a lower bound; a second query would make both exact.
    return this.result(kw, page, Math.max(kw.hits.total.value, fused.length), started);
  }

  private keywords(body: Record<string, unknown>): Promise<OsResponse> {
    return this.os.request<OsResponse>('POST', `${this.index}/_search`, {
      ...body,
      track_total_hits: true,
      aggs: { brands: { terms: { field: 'brand', size: 20 } }, categories: { terms: { field: 'category_top', size: 20 } } },
    });
  }

  private result(r: OsResponse, docs: EngineDoc[], total: number, started: number): SearchResult {
    return {
      items: docs.map(fromEngineDoc),
      total,
      facets: { brands: buckets(r.aggregations?.brands), categories: buckets(r.aggregations?.categories) },
      tookMs: tookMs(started),
    };
  }

  /**
   * Creates the index, the collection and its payload indexes once; "already exists" answers (400/409)
   * count as success. An index created by an older version keeps its mapping: delete it and reindex.
   */
  private ensure(): Promise<unknown> {
    this.ready ??= Promise.all([this.os.request('PUT', this.index, INDEX, [400], WRITE_TIMEOUT_MS), this.createCollection()]).catch(
      (err: unknown) => {
        this.ready = undefined;
        throw err;
      },
    );
    return this.ready;
  }

  private async createCollection(): Promise<void> {
    const vectors = { size: this.embeddings.dim, distance: 'Cosine' };
    await this.qdrant.request('PUT', this.points, { vectors }, [400, 409], WRITE_TIMEOUT_MS);
    for (const [field, schema] of PAYLOAD_INDEXES) {
      await this.qdrant.request('PUT', `${this.points}/index?wait=true`, { field_name: field, field_schema: schema }, [], WRITE_TIMEOUT_MS);
    }
  }
}
