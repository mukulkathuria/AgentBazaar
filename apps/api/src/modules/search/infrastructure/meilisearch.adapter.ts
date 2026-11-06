import type { SearchQuery, SearchResult } from '@agentbazaar/contracts';
import type { SearchDocument, SearchPort } from '../application/ports.js';
import type { EmbeddingsPort } from '../domain/embeddings.js';
import { type EngineDoc, facetList, fromEngineDoc, toEngineDoc, tookMs } from './engine-doc.js';
import { JsonHttp, type JsonHttpOptions } from './json-http.js';

export interface MeilisearchOptions extends JsonHttpOptions {
  url: string;
  apiKey?: string;
  index?: string;
}

interface MeiliResponse {
  hits: EngineDoc[];
  estimatedTotalHits?: number;
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

/**
 * Growth profile: Meilisearch hybrid search (keywords with typo tolerance + our own vectors via a
 * "userProvided" embedder). UNVERIFIED against a live Meilisearch in this repo's CI: request
 * shapes and response mapping are unit-tested with a fake fetch.
 */
export class MeilisearchAdapter implements SearchPort {
  private readonly http: JsonHttp;
  private readonly index: string;
  private settings: Promise<unknown> | undefined;

  constructor(
    opts: MeilisearchOptions,
    private readonly embeddings: EmbeddingsPort,
  ) {
    this.index = `/indexes/${opts.index ?? 'products'}`;
    this.http = new JsonHttp('meilisearch', opts.url, {
      ...opts,
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
    });
  }

  async upsert(doc: SearchDocument, embedding: readonly number[]): Promise<void> {
    await this.ensureSettings();
    await this.http.request('POST', `${this.index}/documents?primaryKey=id`, [{ ...toEngineDoc(doc), _vectors: { default: embedding } }]);
  }

  async remove(productId: string): Promise<void> {
    await this.http.request('DELETE', `${this.index}/documents/${encodeURIComponent(productId)}`);
  }

  async count(): Promise<number> {
    return (await this.http.request<{ numberOfDocuments: number }>('GET', `${this.index}/stats`)).numberOfDocuments;
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const started = performance.now();
    const q = query.q.trim();
    const body: Record<string, unknown> = {
      q,
      filter: meiliFilter(query),
      facets: ['brand', 'category_top'],
      limit: query.limit,
      offset: query.offset,
    };
    const [vector] = q ? await this.embeddings.embed([q]) : [];
    if (vector?.some((x) => x !== 0)) Object.assign(body, { vector, hybrid: { embedder: 'default', semanticRatio: 0.5 } });
    if (!q) body.sort = ['name:asc'];
    const r = await this.http.request<MeiliResponse>('POST', `${this.index}/search`, body);
    return {
      items: r.hits.map(fromEngineDoc),
      total: r.estimatedTotalHits ?? r.hits.length,
      facets: { brands: facetList(r.facetDistribution?.brand), categories: facetList(r.facetDistribution?.category_top) },
      tookMs: tookMs(started),
    };
  }

  /** Applied once, lazily; a failure is retried on the next write. */
  private ensureSettings(): Promise<unknown> {
    this.settings ??= this.http
      .request('PATCH', `${this.index}/settings`, {
        searchableAttributes: ['name', 'brand', 'skus', 'category_name', 'description'],
        filterableAttributes: ['category_paths', 'brand_lc', 'min_price_paise', 'max_price_paise', 'in_stock'],
        sortableAttributes: ['name'],
        embedders: { default: { source: 'userProvided', dimensions: this.embeddings.dim } },
      })
      .catch((err: unknown) => {
        this.settings = undefined;
        throw err;
      });
    return this.settings;
  }
}
