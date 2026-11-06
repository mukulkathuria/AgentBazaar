import { SearchQuery, type SearchResult } from '@agentbazaar/contracts';
import type { SeedCatalog, SeedProduct } from '@agentbazaar/testkit';
import type { SearchQueryInput } from '../../src/modules/search/application/search.service.js';

/**
 * Golden search queries over the deterministic catalog (`generateCatalog`). The relevant products
 * of each query are judged from catalog facts (category, name, brand, SKUs, prices, stock), never
 * from an engine's output, so every engine is scored against the same truth.
 */
export type GoldenKind = 'term' | 'phrase' | 'typo' | 'sku' | 'brand' | 'category' | 'transliterated' | 'filter';

export interface GoldenQuery {
  kind: GoldenKind;
  query: SearchQueryInput;
  /** Slugs a shopper would want. */
  relevant: ReadonlySet<string>;
}

type Fact = (p: SeedProduct) => boolean;

const GPUS = 'electronics.components.gpus';
const PSUS = 'electronics.components.psus';
const KEYBOARDS = 'electronics.accessories.keyboards';
const MICE = 'electronics.accessories.mice';
const CHOCOLATES = 'food.chocolates';
const TEA = 'food.tea';
const NOTEBOOKS = 'stationery.notebooks';

const inCategory =
  (path: string): Fact =>
  (p) =>
    p.categoryPath === path;
const named =
  (phrase: string): Fact =>
  (p) =>
    p.name.toLowerCase().includes(phrase);
const brand =
  (b: string): Fact =>
  (p) =>
    p.brand === b;
const all =
  (...facts: Fact[]): Fact =>
  (p) =>
    facts.every((f) => f(p));
const minPrice = (p: SeedProduct) => Math.min(...p.variants.map((v) => v.pricePaise));
const maxPrice = (p: SeedProduct) => Math.max(...p.variants.map((v) => v.pricePaise));
const inStock: Fact = (p) => p.variants.some((v) => v.stock > 0);

/** The first product at or after `fraction` of the catalog that matches, so picks scale with catalog size. */
function pick(products: readonly SeedProduct[], fraction: number, fact: Fact): SeedProduct {
  const found = products.slice(Math.floor(products.length * fraction)).find(fact);
  if (!found) throw new Error(`No product after ${fraction} of the catalog matches`);
  return found;
}

/** About 55 queries: plain terms, phrases, typos, SKUs, brands, category names, transliterated Hindi and filters. */
export function goldenQueries(seed: Pick<SeedCatalog, 'products'>): GoldenQuery[] {
  const { products } = seed;
  const multiVariant = pick(products, 0.37, (p) => p.variants.length > 1);
  const generated = pick(products, 0.81, (p) => p.variants.length === 1);
  const slug = (s: string): Fact => (p) => p.slug === s;
  const spec: [GoldenKind, SearchQueryInput, Fact][] = [
    ['term', { q: 'chocolate' }, inCategory(CHOCOLATES)],
    ['term', { q: 'keyboard' }, inCategory(KEYBOARDS)],
    ['term', { q: 'graphics card' }, inCategory(GPUS)],
    ['term', { q: 'power supply' }, inCategory(PSUS)],
    ['term', { q: 'mug' }, inCategory('home.mugs')],
    ['term', { q: 'notebook' }, inCategory(NOTEBOOKS)],
    ['term', { q: 'tea' }, inCategory(TEA)],
    ['term', { q: 'mouse' }, inCategory(MICE)],
    ['phrase', { q: 'dark chocolate' }, named('dark chocolate')],
    ['phrase', { q: 'milk chocolate' }, named('milk chocolate')],
    ['phrase', { q: 'green tea' }, named('green tea')],
    ['phrase', { q: 'masala chai' }, named('masala chai')],
    ['phrase', { q: 'gaming mouse' }, named('gaming mouse')],
    ['phrase', { q: 'wireless keyboard' }, named('wireless keyboard')],
    ['phrase', { q: 'mechanical keyboard' }, named('mechanical keyboard')],
    ['phrase', { q: 'coffee mug' }, named('coffee mug')],
    ['phrase', { q: 'oversized t-shirt' }, named('oversized t-shirt')],
    ['phrase', { q: 'mid tower case' }, named('mid tower case')],
    ['phrase', { q: 'dotted journal' }, named('dotted journal')],
    ['typo', { q: 'chocolat' }, inCategory(CHOCOLATES)],
    ['typo', { q: 'keybaord' }, inCategory(KEYBOARDS)],
    ['typo', { q: 'graphcs card' }, inCategory(GPUS)],
    ['typo', { q: 'notebok' }, inCategory(NOTEBOOKS)],
    ['typo', { q: 'ceramc mug' }, named('ceramic mug')],
    ['typo', { q: 'wireles mouse' }, named('wireless mouse')],
    ['typo', { q: 'darjeling tea' }, named('darjeeling')],
    ['sku', { q: 'THOCK-TK87-BLUE' }, slug('thock-tk87-mechanical-keyboard')],
    ['sku', { q: 'KOKOA-MINI-13G-X10' }, slug('kokoa-mini-milk-chocolate-13g')],
    ['sku', { q: 'zentrix-zx9090ti-24g' }, slug('zentrix-zx9090-ti-24gb')],
    ['sku', { q: multiVariant.variants[1]!.sku }, slug(multiVariant.slug)],
    ['sku', { q: generated.variants[0]!.sku }, slug(generated.slug)],
    ['brand', { q: 'zentrix' }, brand('Zentrix')],
    ['brand', { q: 'kokoa craft' }, brand('Kokoa Craft')],
    ['brand', { q: 'voltedge' }, brand('VoltEdge')],
    ['brand', { q: 'glyde' }, brand('Glyde')],
    ['brand', { q: 'cacao lane' }, brand('Cacao Lane')],
    ['brand', { q: 'keyvo mouse' }, all(brand('Keyvo'), inCategory(MICE))],
    ['brand', { q: 'thock mechanical keyboard' }, all(brand('Thock'), named('mechanical keyboard'))],
    ['brand', { q: 'zentrix graphics card' }, all(brand('Zentrix'), inCategory(GPUS))],
    ['category', { q: 'graphics cards' }, inCategory(GPUS)],
    ['category', { q: 'power supplies' }, inCategory(PSUS)],
    ['category', { q: 'pc cases' }, inCategory('electronics.components.cases')],
    ['category', { q: 't-shirts' }, inCategory('apparel.tshirts')],
    ['category', { q: 'notebooks' }, inCategory(NOTEBOOKS)],
    ['transliterated', { q: 'chai' }, named('chai')],
    ['transliterated', { q: 'kagaz' }, brand('Kagaz')],
    ['transliterated', { q: 'mitti mug' }, brand('Mitti & Co')],
    ['transliterated', { q: 'kumhar' }, brand('Kumhar')],
    ['transliterated', { q: 'mithas chocolate' }, brand('Mithas')],
    ['transliterated', { q: 'desi threads tshirt' }, brand('Desi Threads')],
    ['filter', { q: 'chocolate', maxPricePaise: 5000 }, all(inCategory(CHOCOLATES), (p) => minPrice(p) <= 5000)],
    ['filter', { q: 'keyboard', brand: 'Thock' }, all(inCategory(KEYBOARDS), brand('Thock'))],
    ['filter', { q: 'mug', inStockOnly: true }, all(inCategory('home.mugs'), inStock)],
    ['filter', { q: 'graphics card', minPricePaise: 5_000_000 }, all(inCategory(GPUS), (p) => maxPrice(p) >= 5_000_000)],
    ['filter', { q: 'tea', category: TEA, maxPricePaise: 50_000 }, all(inCategory(TEA), (p) => minPrice(p) <= 50_000)],
    ['filter', { q: '', category: PSUS, brand: 'Ampora' }, all(inCategory(PSUS), brand('Ampora'))],
  ];
  return spec.map(([kind, query, fact]) => {
    const relevant = new Set(products.filter(fact).map((p) => p.slug));
    if (!relevant.size) throw new Error(`Golden query ${JSON.stringify(query)} has no relevant product`);
    return { kind, query, relevant };
  });
}

/** Capped recall (BEIR's R_cap@10): relevant hits in the top 10 over min(10, number relevant). */
export function recallAt10(slugs: readonly string[], relevant: ReadonlySet<string>): number {
  return slugs.slice(0, 10).filter((s) => relevant.has(s)).length / Math.min(10, relevant.size);
}

/** nDCG@10 with binary relevance. */
export function ndcgAt10(slugs: readonly string[], relevant: ReadonlySet<string>): number {
  const gain = (i: number) => 1 / Math.log2(i + 2);
  const dcg = slugs.slice(0, 10).reduce((sum, s, i) => sum + (relevant.has(s) ? gain(i) : 0), 0);
  const ideal = Array.from({ length: Math.min(10, relevant.size) }, (_, i) => gain(i)).reduce((a, b) => a + b, 0);
  return dcg / ideal;
}

export interface GoldenScore {
  recall: number;
  ndcg: number;
  byKind: Record<GoldenKind, number>;
  /** Per query: recall@10 and the top-10 results that are not relevant (for the report). */
  perQuery: { query: SearchQueryInput; recall: number; irrelevant: string[] }[];
}

/** Runs every golden query (top 10) through `search` and averages the scores. */
export async function scoreGolden(golden: readonly GoldenQuery[], search: (q: SearchQuery) => Promise<SearchResult>): Promise<GoldenScore> {
  const perQuery: (GoldenScore['perQuery'][number] & { kind: GoldenKind; ndcg: number })[] = [];
  for (const g of golden) {
    const slugs = (await search(SearchQuery.parse({ ...g.query, limit: 10 }))).items.map((i) => i.slug);
    const irrelevant = slugs.slice(0, 10).filter((s) => !g.relevant.has(s));
    perQuery.push({ kind: g.kind, query: g.query, recall: recallAt10(slugs, g.relevant), ndcg: ndcgAt10(slugs, g.relevant), irrelevant });
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const kinds = [...new Set(perQuery.map((r) => r.kind))];
  return {
    recall: mean(perQuery.map((r) => r.recall)),
    ndcg: mean(perQuery.map((r) => r.ndcg)),
    byKind: Object.fromEntries(kinds.map((k) => [k, mean(perQuery.filter((r) => r.kind === k).map((r) => r.recall))])) as Record<GoldenKind, number>,
    perQuery: perQuery.map(({ query, recall, irrelevant }) => ({ query, recall, irrelevant })),
  };
}
