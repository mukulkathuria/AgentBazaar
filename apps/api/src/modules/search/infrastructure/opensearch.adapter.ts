import type { SearchQuery, SearchResult } from '@agentbazaar/contracts';
import type { SearchDocument, SearchPort } from '../application/ports.js';
import type { EmbeddingsPort } from '../domain/embeddings.js';
import { MIN_VECTOR_SIMILARITY, reciprocalRankFusion } from '../domain/ranking.js';
import { type EngineDoc, facetList, fromEngineDoc, toEngineDoc, tookMs } from './engine-doc.js';
import { JsonHttp, type JsonHttpOptions } from './json-http.js';

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

const MAPPINGS = {
  properties: {
    name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    brand: { type: 'keyword' },
    brand_lc: { type: 'keyword' },
    category_path: { type: 'keyword' },
    category_paths: { type: 'keyword' },
    category_top: { type: 'keyword' },
    category_name: { type: 'text' },
    description: { type: 'text' },
    skus: { type: 'text' },
    min_price_paise: { type: 'long' },
    max_price_paise: { type: 'long' },
    in_stock: { type: 'boolean' },
  },
};

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
 * with Reciprocal Rank Fusion. UNVERIFIED against live engines in this repo's CI: request shapes
 * and response mapping are unit-tested with a fake fetch.
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

  async upsert(doc: SearchDocument, embedding: readonly number[]): Promise<void> {
    await this.ensure();
    const body = toEngineDoc(doc);
    await this.os.request('PUT', `${this.index}/_doc/${encodeURIComponent(doc.productId)}`, body);
    await this.qdrant.request('PUT', `${this.points}/points?wait=true`, { points: [{ id: doc.productId, vector: embedding, payload: body }] });
  }

  async remove(productId: string): Promise<void> {
    await this.os.request('DELETE', `${this.index}/_doc/${encodeURIComponent(productId)}`, undefined, [404]);
    await this.qdrant.request('POST', `${this.points}/points/delete?wait=true`, { points: [productId] });
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
    const [kw, vec] = await Promise.all([
      this.keywords({
        from: 0,
        size: depth,
        query: { bool: { must: [{ multi_match: { query: q, fields: ['name^3', 'category_name^2', 'skus', 'description'], fuzziness: 'AUTO' } }], filter } },
      }),
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
    const fused = reciprocalRankFusion([kw.hits.hits.map((h) => h._id), vec.result.map((p) => String(p.id))]);
    const page = fused.slice(query.offset, query.offset + query.limit).map((f) => docs.get(f.id)!);
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

  /** Creates the index and collection once; "already exists" answers (400/409) count as success. */
  private ensure(): Promise<unknown> {
    this.ready ??= Promise.all([
      this.os.request('PUT', this.index, { mappings: MAPPINGS }, [400]),
      this.qdrant.request('PUT', this.points, { vectors: { size: this.embeddings.dim, distance: 'Cosine' } }, [400, 409]),
    ]).catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }
}
