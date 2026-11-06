import { SearchQuery } from '@agentbazaar/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { SearchDocument } from '../application/ports.js';
import { hashEmbed, HashEmbeddings } from '../domain/embeddings.js';
import { AiServiceEmbeddings } from './ai-service-embeddings.js';
import { toEngineDoc } from './engine-doc.js';
import { JsonHttp, type FetchLike } from './json-http.js';
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
    const headers = init.headers as Record<string, string>;
    const text = typeof init.body === 'string' ? init.body : undefined;
    // NDJSON (bulk) bodies are recorded as the list of their lines.
    const body: unknown =
      text === undefined
        ? undefined
        : headers['content-type'] === 'application/x-ndjson'
          ? text.trimEnd().split('\n').map((line) => JSON.parse(line) as unknown)
          : JSON.parse(text);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body, headers });
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

  it('configures the index once, then writes each batch of documents with their vectors in one request', async () => {
    const { adapter, calls } = make();
    await adapter.upsert([], []);
    expect(calls).toHaveLength(0);
    await adapter.upsert([doc], [hashEmbed('x')]);
    await adapter.upsert([doc, { ...doc, productId: 'aaaaaaaa-0000-4000-8000-000000000000' }], [hashEmbed('x'), hashEmbed('y')]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PATCH http://meili:7700/indexes/products/settings',
      'POST http://meili:7700/indexes/products/documents?primaryKey=id',
      'POST http://meili:7700/indexes/products/documents?primaryKey=id',
    ]);
    expect(calls[0]!.headers.authorization).toBe('Bearer k3y');
    expect(calls[0]!.body).toMatchObject({
      // Facet attributes must be filterable too, or Meilisearch rejects every search.
      filterableAttributes: ['category_paths', 'brand_lc', 'min_price_paise', 'max_price_paise', 'in_stock', 'brand', 'category_top'],
      pagination: { maxTotalHits: 5050 },
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
    expect((calls[2]!.body as { _vectors: { default: number[] } }[]).map((d) => d._vectors.default)).toEqual([hashEmbed('x'), hashEmbed('y')]);
  });

  it('runs a filtered hybrid search with keyword-only totals and facets in one multi-search', async () => {
    const { adapter, calls } = make(() => ({
      json: { results: [{ hits: [engineDoc] }, { hits: [], facetDistribution: { brand: { Keyvo: 2, Thock: 5 }, category_top: { electronics: 7 } } }] },
    }));
    const r = await adapter.search(filtered);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://meili:7700/multi-search');
    const filter = ['category_paths = "electronics"', 'brand_lc = "thock"', 'max_price_paise >= 100', 'min_price_paise <= 600000', 'in_stock = true'];
    const [page, counts] = (calls[0]!.body as { queries: Record<string, unknown>[] }).queries;
    expect(page).toMatchObject({
      indexUid: 'products',
      q: 'keyboard',
      filter,
      limit: 5,
      offset: 0,
      hybrid: { embedder: 'default', semanticRatio: 0.5 },
      showRankingScore: true,
    });
    expect(page).not.toHaveProperty('rankingScoreThreshold');
    expect(page!.vector).toEqual(hashEmbed('keyboard'));
    expect(counts).toEqual({ indexUid: 'products', q: 'keyboard', filter, facets: ['brand', 'category_top'], limit: 0 });
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

  it('never reports fewer results than it returned (vector-only hits have no keyword count)', async () => {
    const { adapter } = make(() => ({ json: { results: [{ hits: [engineDoc, engineDoc] }, { hits: [] }] } }));
    const r = await adapter.search(SearchQuery.parse({ q: 'keybaord', offset: 12 }));
    expect(r).toMatchObject({ total: 14, facets: { brands: [], categories: [] } });
  });

  it('drops hybrid hits under the cosine floor of the other engines ((1 + 0.3) / 2 on its scale)', async () => {
    const hit = (score: number) => ({ ...engineDoc, _rankingScore: score });
    const { adapter } = make(() => ({ json: { results: [{ hits: [hit(0.98), hit(0.65), hit(0.6499)] }, { hits: [] }] } }));
    const r = await adapter.search(SearchQuery.parse({ q: 'xyzzy qwerty' }));
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it('browses by name without vectors and escapes quotes in filter values', async () => {
    const { adapter, calls } = make(() => ({ json: { results: [{ hits: [] }, { hits: [] }] } }));
    const r = await adapter.search(SearchQuery.parse({ brand: 'Bob "The" \\ Brand' }));
    const filter = ['brand_lc = "bob \\"the\\" \\\\ brand"'];
    expect(calls[0]!.body).toEqual({
      queries: [
        { indexUid: 'products', q: '', filter, limit: 12, offset: 0, sort: ['name:asc'] },
        { indexUid: 'products', q: '', filter, facets: ['brand', 'category_top'], limit: 0 },
      ],
    });
    expect(r.total).toBe(0);
  });

  it('turns engine errors into 503s and opens the circuit after repeated failures', async () => {
    const { adapter, calls } = make(() => ({ status: 500, json: { message: 'boom' } }));
    for (let i = 0; i < 5; i++) await expect(adapter.count()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(adapter.count()).rejects.toThrow(/temporarily unavailable/);
    expect(calls).toHaveLength(5);
  });
});

describe('@scale OpenSearch + Qdrant adapter (fake fetch)', () => {
  const other = { ...engineDoc, id: 'aaaaaaaa-0000-4000-8000-000000000000', slug: 'keyvo-kb', skus: ['KEYVO-KB-1'] };
  const third = { ...engineDoc, id: 'bbbbbbbb-0000-4000-8000-000000000000', slug: 'thock-kb-2', skus: ['THOCK-KB-2'] };
  const make = (respond?: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(respond);
    const adapter = new OpenSearchAdapter({ url: 'http://os:9200', qdrantUrl: 'http://qdrant:6333', fetch: f.fetch }, embeddings);
    return { ...f, adapter };
  };

  const bulkOk = { json: { errors: false, items: [{ index: { status: 201 } }] } };

  it('creates the index and collection once, then writes each batch to both engines in one request each', async () => {
    const { adapter, calls } = make((url, method) =>
      method === 'PUT' && url === 'http://os:9200/products' ? { status: 400 } : url.endsWith('_bulk') ? bulkOk : {},
    );
    await adapter.upsert([], []);
    expect(calls).toHaveLength(0);
    await adapter.upsert([doc], [hashEmbed('x')]);
    await adapter.upsert([doc, { ...doc, productId: other.id }], [hashEmbed('x'), hashEmbed('y')]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PUT http://os:9200/products',
      'PUT http://qdrant:6333/collections/products',
      'POST http://os:9200/products/_bulk',
      'PUT http://qdrant:6333/collections/products/points?wait=true',
      'POST http://os:9200/products/_bulk',
      'PUT http://qdrant:6333/collections/products/points?wait=true',
    ]);
    expect(calls[1]!.body).toEqual({ vectors: { size: 256, distance: 'Cosine' } });
    expect(calls[2]!.headers['content-type']).toBe('application/x-ndjson');
    expect(calls[2]!.body).toEqual([{ index: { _id: doc.productId } }, engineDoc]);
    expect(calls[3]!.body).toMatchObject({ points: [{ id: doc.productId, payload: { brand_lc: 'thock' } }] });
    expect((calls[4]!.body as unknown[]).filter((_, i) => i % 2 === 0)).toEqual([{ index: { _id: doc.productId } }, { index: { _id: other.id } }]);
    expect((calls[5]!.body as { points: { id: string; vector: number[] }[] }).points.map((p) => [p.id, p.vector])).toEqual([
      [doc.productId, hashEmbed('x')],
      [other.id, hashEmbed('y')],
    ]);
  });

  it('fails the batch, before touching Qdrant, when OpenSearch rejects a document', async () => {
    const { adapter, calls } = make((url) =>
      url.endsWith('_bulk')
        ? { json: { errors: true, items: [{ index: { status: 201 } }, { index: { status: 400, error: { reason: 'mapper_parsing_exception' } } }] } }
        : {},
    );
    await expect(adapter.upsert([doc, doc], [hashEmbed('x'), hashEmbed('x')])).rejects.toThrow(/rejected 1 of 2 documents: mapper_parsing_exception/);
    expect(calls.some((c) => c.url.endsWith('/points?wait=true'))).toBe(false);
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
    // `other` is ranked by both engines, so it wins; keyword #1 then beats vector #1, as the keyword ranking counts twice.
    expect(r.items.map((i) => i.slug)).toEqual(['keyvo-kb', 'thock-tk87-mechanical-keyboard', 'thock-kb-2']);
    expect(r.total).toBe(3);
    expect(r.facets).toEqual({ brands: [{ value: 'Thock', count: 2 }], categories: [{ value: 'electronics', count: 2 }] });
  });

  it('puts the product with an exact SKU first, even when fusion favours products both engines found', async () => {
    const { adapter } = make((url) =>
      url.includes('qdrant')
        ? { json: { result: [{ id: other.id, score: 0.9, payload: other }, { id: third.id, score: 0.8, payload: third }] } }
        : {
            json: {
              hits: {
                total: { value: 3 },
                hits: [
                  { _id: other.id, _source: other },
                  { _id: third.id, _source: third },
                  { _id: engineDoc.id, _source: engineDoc },
                ],
              },
            },
          },
    );
    const r = await adapter.search(SearchQuery.parse({ q: 'thock-tk87-blue' }));
    expect(r.items.map((i) => i.slug)).toEqual(['thock-tk87-mechanical-keyboard', 'keyvo-kb', 'thock-kb-2']);
    const plain = await adapter.search(SearchQuery.parse({ q: 'keyboard' }));
    expect(plain.items.map((i) => i.slug)).toEqual(['keyvo-kb', 'thock-kb-2', 'thock-tk87-mechanical-keyboard']);
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

describe('@lite JSON over HTTP', () => {
  const slow: FetchLike = (_url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('{"ok":true}')), 60);
      init.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))));
    });

  it('gives up at the default timeout unless the call allows longer (index creation, bulk writes)', async () => {
    const http = new JsonHttp('engine', 'http://engine', { fetch: slow, timeoutMs: 10 });
    await expect(http.request('GET', '/')).rejects.toThrow(/Timed out after 10 ms/);
    await expect(http.request('GET', '/', undefined, [], 1000)).resolves.toEqual({ ok: true });
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
