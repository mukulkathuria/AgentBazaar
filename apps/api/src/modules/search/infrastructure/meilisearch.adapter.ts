import type { SearchQuery, SearchResult } from '@agentbazaar/contracts';
import type { SearchDocument, SearchPort } from '../application/ports.js';
import type { EmbeddingsPort } from '../domain/embeddings.js';
import { MIN_VECTOR_SIMILARITY } from '../domain/ranking.js';
import { type EngineDoc, facetList, fromEngineDoc, toEngineDoc, tookMs } from './engine-doc.js';
import { JsonHttp, type JsonHttpOptions, WRITE_TIMEOUT_MS } from './json-http.js';

export interface MeilisearchOptions extends JsonHttpOptions {
  url: string;
  apiKey?: string;
  index?: string;
}

interface MeiliResponse {
  hits: EngineDoc[];
  facetDistribution?: Record<string, Record<string, number>>;
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Our filters in Meilisearch filter syntax (price filters overlap the variant price range). */
export function meiliFilter(q: SearchQuery): string[] {
  const f: string[] = [];
  if (q.category) f.push(`category_paths = ${quote(q.category.toLowerCase())}`);
  if (q.brand) f.push(`brand_lc = ${quote(q.brand.toLowerCase())}`);
  if (q.minPricePaise !== undefined) f.push(`max_price_paise >= ${q.minPricePaise}`);
  if (q.maxPricePaise !== undefined) f.push(`min_price_paise <= ${q.maxPricePaise}`);
  if (q.inStockOnly) f.push('in_stock = true');
  return f;
}

/** SearchQuery allows offset 5,000 plus limit 50; Meilisearch returns nothing past maxTotalHits (default 1,000). */
const MAX_TOTAL_HITS = 5_050;
/** Meilisearch scores a vector hit (1 + cosine) / 2, so this is the cosine floor the other engines use. */
const MIN_HYBRID_SCORE = (1 + MIN_VECTOR_SIMILARITY) / 2;

const sum = (counts: Record<string, number> = {}) => Object.values(counts).reduce((a, b) => a + b, 0);

/**
 * Growth profile: Meilisearch hybrid search (keywords with typo tolerance + our own vectors via a
 * "userProvided" embedder). Verified against a live Meilisearch by apps/api/test/services.
 * Writes are queued as Meilisearch tasks, so they become visible once the engine has applied them.
 */
export class MeilisearchAdapter implements SearchPort {
  private readonly http: JsonHttp;
  private readonly uid: string;
  private readonly index: string;
  private settings: Promise<unknown> | undefined;

  constructor(
    opts: MeilisearchOptions,
    private readonly embeddings: EmbeddingsPort,
  ) {
    this.uid = opts.index ?? 'products';
    this.index = `/indexes/${this.uid}`;
    this.http = new JsonHttp('meilisearch', opts.url, {
      ...opts,
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
    });
  }

  async upsert(docs: readonly SearchDocument[], embeddings: readonly (readonly number[])[]): Promise<void> {
    if (!docs.length) return;
    await this.ensureSettings();
    const body = docs.map((doc, i) => ({ ...toEngineDoc(doc), _vectors: { default: embeddings[i] } }));
    await this.http.request('POST', `${this.index}/documents?primaryKey=id`, body, [], WRITE_TIMEOUT_MS);
  }

  async remove(productId: string): Promise<void> {
    await this.http.request('DELETE', `${this.index}/documents/${encodeURIComponent(productId)}`, undefined, [], WRITE_TIMEOUT_MS);
  }

  async count(): Promise<number> {
    return (await this.http.request<{ numberOfDocuments: number }>('GET', `${this.index}/stats`)).numberOfDocuments;
  }

  /**
   * One multi-search round trip: the page (hybrid when the query has a vector), and a keyword-only
   * count for the total and facets. A hybrid query counts every vector neighbour, which is the
   * whole index, so like the scale engine the total is a lower bound for hybrid hits.
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    const started = performance.now();
    const q = query.q.trim();
    const filter = meiliFilter(query);
    const page: Record<string, unknown> = { indexUid: this.uid, q, filter, limit: query.limit, offset: query.offset };
    const [vector] = q ? await this.embeddings.embed([q]) : [];
    if (vector?.some((x) => x !== 0)) {
      Object.assign(page, { vector, hybrid: { embedder: 'default', semanticRatio: 0.5 }, rankingScoreThreshold: MIN_HYBRID_SCORE });
    }
    if (!q) page.sort = ['name:asc'];
    const counts = { indexUid: this.uid, q, filter, facets: ['brand', 'category_top'], limit: 0 };
    const { results } = await this.http.request<{ results: [MeiliResponse, MeiliResponse] }>('POST', '/multi-search', {
      queries: [page, counts],
    });
    const [hits, all] = results;
    // Facet counts are exhaustive and every document has one top category, unlike the capped estimatedTotalHits.
    const matched = sum(all.facetDistribution?.category_top);
    return {
      items: hits.hits.map(fromEngineDoc),
      total: Math.max(matched, query.offset + hits.hits.length),
      facets: { brands: facetList(all.facetDistribution?.brand), categories: facetList(all.facetDistribution?.category_top) },
      tookMs: tookMs(started),
    };
  }

  /** Applied once, lazily; a failure is retried on the next write. Facet attributes must be filterable. */
  private ensureSettings(): Promise<unknown> {
    const settings = {
      searchableAttributes: ['name', 'brand', 'skus', 'category_name', 'description'],
      filterableAttributes: ['category_paths', 'brand_lc', 'min_price_paise', 'max_price_paise', 'in_stock', 'brand', 'category_top'],
      sortableAttributes: ['name'],
      pagination: { maxTotalHits: MAX_TOTAL_HITS },
      embedders: { default: { source: 'userProvided', dimensions: this.embeddings.dim } },
    };
    this.settings ??= this.http
      .request('PATCH', `${this.index}/settings`, settings, [], WRITE_TIMEOUT_MS)
      .catch((err: unknown) => {
        this.settings = undefined;
        throw err;
      });
    return this.settings;
  }
}
