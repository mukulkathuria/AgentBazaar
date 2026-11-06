import { SearchQuery } from '@agentbazaar/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { SearchDocument } from '../application/ports.js';
import { hashEmbed, HashEmbeddings } from '../domain/embeddings.js';
import { AiServiceEmbeddings } from './ai-service-embeddings.js';
import { toEngineDoc } from './engine-doc.js';
import type { FetchLike } from './json-http.js';
import { MeilisearchAdapter } from './meilisearch.adapter.js';
import { OpenSearchAdapter } from './opensearch.adapter.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Records every request and answers from `respond` (status 200 unless given). */
function fakeFetch(respond: (url: string, method: string, body: unknown) => { status?: number; json?: unknown } = () => ({})) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init.method ?? 'GET';
    calls.push({ url, method, body, headers: init.headers as Record<string, string> });
    const r = respond(url, method, body);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { fetch, calls };
}

const doc: SearchDocument = {
  productId: '3f2b8c1e-6a4d-4e7f-9b1a-2c3d4e5f6a7b',
  slug: 'thock-tk87-mechanical-keyboard',
  name: 'Thock TK-87 Hot-swap Mechanical Keyboard',
  brand: 'Thock',
  categoryPath: 'electronics.accessories.keyboards',
  categoryName: 'Keyboards',
  description: 'Tenkeyless keyboard.',
  skus: ['THOCK-TK87-RED', 'THOCK-TK87-BLUE'],
  defaultSku: 'THOCK-TK87-RED',
  band: 'standard',
  minPricePaise: 529_900,
  maxPricePaise: 549_900,
  inStock: true,
  image: null,
  customizable: false,
};
const engineDoc = toEngineDoc(doc);
const summary = {
  id: doc.productId,
  slug: doc.slug,
  name: doc.name,
  brand: 'Thock',
  categoryPath: doc.categoryPath,
  band: 'standard',
  minPricePaise: 529_900,
  maxPricePaise: 549_900,
  inStock: true,
  image: null,
  customizable: false,
  defaultSku: 'THOCK-TK87-RED',
};
const filtered = SearchQuery.parse({
  q: 'keyboard',
  category: 'Electronics',
  brand: 'THOCK',
  minPricePaise: 100,
  maxPricePaise: 600_000,
  inStockOnly: true,
  limit: 5,
  offset: 0,
});
const embeddings = new HashEmbeddings();

describe('@growth Meilisearch adapter (fake fetch)', () => {
  const make = (respond?: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(respond);
    return { ...f, adapter: new MeilisearchAdapter({ url: 'http://meili:7700/', apiKey: 'k3y', fetch: f.fetch }, embeddings) };
  };

  it('configures the index once, then writes documents with their vector', async () => {
    const { adapter, calls } = make();
    await adapter.upsert(doc, hashEmbed('x'));
    await adapter.upsert(doc, hashEmbed('x'));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PATCH http://meili:7700/indexes/products/settings',
      'POST http://meili:7700/indexes/products/documents?primaryKey=id',
      'POST http://meili:7700/indexes/products/documents?primaryKey=id',
    ]);
    expect(calls[0]!.headers.authorization).toBe('Bearer k3y');
    expect(calls[0]!.body).toMatchObject({
      filterableAttributes: ['category_paths', 'brand_lc', 'min_price_paise', 'max_price_paise', 'in_stock'],
      embedders: { default: { source: 'userProvided', dimensions: 256 } },
    });
    const [written] = calls[1]!.body as Record<string, unknown>[];
    expect(written).toMatchObject({
      id: doc.productId,
      brand_lc: 'thock',
      category_paths: ['electronics', 'electronics.accessories', 'electronics.accessories.keyboards'],
      category_top: 'electronics',
    });
    expect((written!._vectors as { default: number[] }).default).toHaveLength(256);
  });

  it('runs a filtered hybrid search and maps hits, totals and facets', async () => {
    const { adapter, calls } = make(() => ({
      json: { hits: [engineDoc], estimatedTotalHits: 7, facetDistribution: { brand: { Keyvo: 2, Thock: 5 }, category_top: { electronics: 7 } } },
    }));
    const r = await adapter.search(filtered);
    expect(calls[0]!.url).toBe('http://meili:7700/indexes/products/search');
    expect(calls[0]!.body).toMatchObject({
      q: 'keyboard',
      filter: [
        'category_paths = "electronics"',
        'brand_lc = "thock"',
        'max_price_paise >= 100',
        'min_price_paise <= 600000',
        'in_stock = true',
      ],
      facets: ['brand', 'category_top'],
      limit: 5,
      offset: 0,
      hybrid: { embedder: 'default', semanticRatio: 0.5 },
    });
    expect((calls[0]!.body as { vector: number[] }).vector).toEqual(hashEmbed('keyboard'));
    expect(r.items).toEqual([summary]);
    expect(r.total).toBe(7);
    expect(r.facets).toEqual({
      brands: [
        { value: 'Thock', count: 5 },
        { value: 'Keyvo', count: 2 },
      ],
      categories: [{ value: 'electronics', count: 7 }],
    });
  });

  it('browses by name without vectors and escapes quotes in filter values', async () => {
    const { adapter, calls } = make(() => ({ json: { hits: [], estimatedTotalHits: 0 } }));
    await adapter.search(SearchQuery.parse({ brand: 'Bob "The" \\ Brand' }));
    expect(calls[0]!.body).toEqual({
      q: '',
      filter: ['brand_lc = "bob \\"the\\" \\\\ brand"'],
      facets: ['brand', 'category_top'],
      limit: 12,
      offset: 0,
      sort: ['name:asc'],
    });
  });

  it('turns engine errors into 503s and opens the circuit after repeated failures', async () => {
    const { adapter, calls } = make(() => ({ status: 500, json: { message: 'boom' } }));
    for (let i = 0; i < 5; i++) await expect(adapter.count()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(adapter.count()).rejects.toThrow(/temporarily unavailable/);
    expect(calls).toHaveLength(5);
  });
});

describe('@scale OpenSearch + Qdrant adapter (fake fetch)', () => {
  const other = { ...engineDoc, id: 'aaaaaaaa-0000-4000-8000-000000000000', slug: 'keyvo-kb' };
  const third = { ...engineDoc, id: 'bbbbbbbb-0000-4000-8000-000000000000', slug: 'thock-kb-2' };
  const make = (respond?: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(respond);
    const adapter = new OpenSearchAdapter({ url: 'http://os:9200', qdrantUrl: 'http://qdrant:6333', fetch: f.fetch }, embeddings);
    return { ...f, adapter };
  };

  it('creates the index and collection once, then writes the document to both engines', async () => {
    const { adapter, calls } = make((url, method) => (method === 'PUT' && url === 'http://os:9200/products' ? { status: 400 } : {}));
    await adapter.upsert(doc, hashEmbed('x'));
    await adapter.upsert(doc, hashEmbed('x'));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT http://os:9200/products',
      'PUT http://qdrant:6333/collections/products',
      `PUT http://os:9200/products/_doc/${doc.productId}`,
      'PUT http://qdrant:6333/collections/products/points?wait=true',
      `PUT http://os:9200/products/_doc/${doc.productId}`,
      'PUT http://qdrant:6333/collections/products/points?wait=true',
    ]);
    expect(calls[1]!.body).toEqual({ vectors: { size: 256, distance: 'Cosine' } });
    expect(calls[3]!.body).toMatchObject({ points: [{ id: doc.productId, payload: { brand_lc: 'thock' } }] });
  });

  it('fuses keyword and vector rankings with RRF and maps facets', async () => {
    const { adapter, calls } = make((url) =>
      url.includes('qdrant')
        ? { json: { result: [{ id: third.id, score: 0.8, payload: third }, { id: other.id, score: 0.5, payload: other }] } }
        : {
            json: {
              hits: { total: { value: 2 }, hits: [{ _id: engineDoc.id, _source: engineDoc }, { _id: other.id, _source: other }] },
              aggregations: { brands: { buckets: [{ key: 'Thock', doc_count: 2 }] }, categories: { buckets: [{ key: 'electronics', doc_count: 2 }] } },
            },
          },
    );
    const r = await adapter.search(filtered);
    const os = calls.find((c) => c.url === 'http://os:9200/products/_search')!;
    expect(os.body).toMatchObject({
      from: 0,
      size: 50,
      track_total_hits: true,
      query: {
        bool: {
          must: [{ multi_match: { query: 'keyboard', fuzziness: 'AUTO' } }],
          filter: [
            { term: { category_paths: 'electronics' } },
            { term: { brand_lc: 'thock' } },
            { range: { max_price_paise: { gte: 100 } } },
            { range: { min_price_paise: { lte: 600_000 } } },
            { term: { in_stock: true } },
          ],
        },
      },
    });
    const qdrant = calls.find((c) => c.url === 'http://qdrant:6333/collections/products/points/search')!;
    expect(qdrant.body).toMatchObject({ limit: 50, with_payload: true, score_threshold: 0.3 });
    expect((qdrant.body as { filter: { must: unknown[] } }).filter.must).toEqual([
      { key: 'category_paths', match: { value: 'electronics' } },
      { key: 'brand_lc', match: { value: 'thock' } },
      { key: 'max_price_paise', range: { gte: 100 } },
      { key: 'min_price_paise', range: { lte: 600_000 } },
      { key: 'in_stock', match: { value: true } },
    ]);
    // `other` is ranked by both engines, so it wins; then keyword #1 beats vector #1 on the id tie-break.
    expect(r.items.map((i) => i.slug)).toEqual(['keyvo-kb', 'thock-tk87-mechanical-keyboard', 'thock-kb-2']);
    expect(r.total).toBe(3);
    expect(r.facets).toEqual({ brands: [{ value: 'Thock', count: 2 }], categories: [{ value: 'electronics', count: 2 }] });
  });

  it('browses with keyword search only, paged by the engine', async () => {
    const { adapter, calls } = make(() => ({ json: { hits: { total: { value: 40 }, hits: [{ _id: engineDoc.id, _source: engineDoc }] } } }));
    const r = await adapter.search(SearchQuery.parse({ offset: 12 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ from: 12, size: 12, sort: [{ 'name.keyword': 'asc' }], query: { bool: { filter: [] } } });
    expect(r).toMatchObject({ total: 40, items: [summary] });
  });

  it('removes from both engines and tolerates a document that is already gone', async () => {
    const { adapter, calls } = make((url) => (url.includes('_doc') ? { status: 404 } : {}));
    await adapter.remove(doc.productId);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE http://os:9200/products/_doc/${doc.productId}`,
      'POST http://qdrant:6333/collections/products/points/delete?wait=true',
    ]);
    expect(calls[1]!.body).toEqual({ points: [doc.productId] });
  });
});

describe('@lite AI service embeddings (fake fetch)', () => {
  const vectors = (n: number) => Array.from({ length: n }, () => Array<number>(256).fill(0.0625));

  it('posts texts in contract-sized batches and returns the vectors', async () => {
    const { fetch, calls } = fakeFetch((_u, _m, body) => {
      const n = (body as { texts: string[] }).texts.length;
      return { json: { model: 'minilm-256', dim: 256, vectors: vectors(n) } };
    });
    const e = new AiServiceEmbeddings('http://ai:8000', { fetch });
    const texts = Array.from({ length: 70 }, (_, i) => (i === 0 ? 'x'.repeat(3000) : `text ${i}`));
    const out = await e.embed(texts);
    expect(out).toHaveLength(70);
    expect(calls.map((c) => [c.method, c.url, (c.body as { texts: string[] }).texts.length])).toEqual([
      ['POST', 'http://ai:8000/v1/embed', 64],
      ['POST', 'http://ai:8000/v1/embed', 6],
    ]);
    expect((calls[0]!.body as { texts: string[] }).texts[0]).toHaveLength(2000);
  });

  it.each([
    ['an HTTP error', () => ({ status: 503 })],
    ['the wrong dimension', () => ({ json: { model: 'big', dim: 384, vectors: [Array<number>(384).fill(0)] } })],
    ['a malformed body', () => ({ json: { nope: true } })],
  ])('falls back to hash vectors on %s', async (_name, respond) => {
    const onFallback = vi.fn();
    const { fetch } = fakeFetch(respond);
    const out = await new AiServiceEmbeddings('http://ai:8000', { fetch, onFallback }).embed(['mechanical keyboard']);
    expect(out).toEqual([hashEmbed('mechanical keyboard')]);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('falls back when the service hangs past the timeout', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const out = await new AiServiceEmbeddings('http://ai:8000', { fetch: hang, timeoutMs: 20 }).embed(['tea']);
    expect(out).toEqual([hashEmbed('tea')]);
  });
});
