import type { SearchResult } from '@agentbazaar/contracts';
import { generateCatalog, type SeedCatalog } from '@agentbazaar/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { InventoryService } from '../../src/modules/inventory/index.js';
import { SearchIndexer } from '../../src/modules/search/application/search-indexer.js';
import { HashEmbeddings } from '../../src/modules/search/domain/embeddings.js';
import { PgSearchAdapter } from '../../src/modules/search/infrastructure/pg-search.adapter.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { systemClock } from '../../src/shared/kernel/clock.js';
import { createTestDb, type TestDb } from '../support/test-db.js';

const KEYBOARDS = 'electronics.accessories.keyboards';
const CHOCOLATES = 'food.chocolates';

describe('@lite search golden queries (1,000 products)', () => {
  let t: TestDb;
  let search: PgSearchAdapter;
  let seed: SeedCatalog;
  const find = (q: string, extra: Record<string, unknown> = {}): Promise<SearchResult> =>
    search.search({ q, inStockOnly: false, limit: 12, offset: 0, ...extra });
  const categories = (r: SearchResult) => r.items.map((i) => i.categoryPath);

  beforeAll(async () => {
    t = await createTestDb({ poolMax: 4 });
    const db = t.database.db;
    const catalog = new CatalogService(db, new InventoryService(db, systemClock));
    seed = generateCatalog({ products: 1000 });
    await inTransaction(db, (tx) => catalog.importSeed(tx, seed, new Map()));
    const embeddings = new HashEmbeddings();
    search = new PgSearchAdapter(db, embeddings);
    expect(await new SearchIndexer(search, embeddings, catalog).reindexAll()).toBe(1000);
  }, 300_000);
  afterAll(async () => t.cleanup());

  it('"gpu 12gb" puts the 12 GB Zentrix card in the top 3', async () => {
    const r = await find('gpu 12gb');
    expect(r.items.slice(0, 3).map((i) => i.slug)).toContain('zentrix-zx7070-12gb');
  });

  it('"mechanical keyboard" lists keyboards first', async () => {
    const r = await find('mechanical keyboard');
    expect(categories(r).slice(0, 10)).toEqual(Array(10).fill(KEYBOARDS));
    expect(r.items.slice(0, 10).every((i) => /mechanical/i.test(i.name))).toBe(true);
  });

  it('the typo "keybaord" still finds keyboards', async () => {
    const r = await find('keybaord');
    expect(r.total).toBeGreaterThan(0);
    expect(categories(r)).toEqual(Array(r.items.length).fill(KEYBOARDS));
  });

  it('"chocolate under ₹50" honours maxPricePaise and keeps the 13 g hero bar', async () => {
    const r = await find('chocolate', { maxPricePaise: 5000, limit: 50 });
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.every((i) => i.minPricePaise <= 5000 && i.categoryPath === CHOCOLATES)).toBe(true);
    expect(r.items.map((i) => i.slug)).toContain('kokoa-mini-milk-chocolate-13g');
  });

  it('filters by category subtree, with exact totals and facets', async () => {
    const expected = seed.products.filter((p) => p.categoryPath.startsWith('food.')).length;
    const r = await find('', { category: 'food', limit: 50 });
    expect(r.total).toBe(expected);
    expect(r.facets.categories).toEqual([{ value: 'food', count: expected }]);
    const chocolates = await find('', { category: CHOCOLATES, limit: 50 });
    expect(chocolates.total).toBe(seed.products.filter((p) => p.categoryPath === CHOCOLATES).length);
    expect(new Set(categories(chocolates))).toEqual(new Set([CHOCOLATES]));
    expect(chocolates.facets.brands.reduce((n, f) => n + f.count, 0)).toBe(chocolates.total);
  });

  it('inStockOnly excludes products with no stock in any variant', async () => {
    const inStock = seed.products.filter((p) => p.variants.some((v) => v.stock > 0)).length;
    expect(inStock).toBeLessThan(1000);
    expect((await find('')).total).toBe(1000);
    const r = await find('', { inStockOnly: true, limit: 50 });
    expect(r.total).toBe(inStock);
    expect(r.items.every((i) => i.inStock)).toBe(true);
    const text = await find('graphics card', { inStockOnly: true, limit: 50 });
    expect(text.total).toBeGreaterThan(0);
    expect(text.items.every((i) => i.inStock)).toBe(true);
  });

  it('matches SKUs and brands case-insensitively', async () => {
    expect((await find('THOCK-TK87-RED')).items[0]?.slug).toBe('thock-tk87-mechanical-keyboard');
    const r = await find('', { brand: 'zentrix', limit: 50 });
    expect(r.total).toBe(seed.products.filter((p) => p.brand === 'Zentrix').length);
    expect(r.facets.brands).toEqual([{ value: 'Zentrix', count: r.total }]);
  });

  it('applies price ranges as an overlap with the variant price range', async () => {
    const r = await find('', { minPricePaise: 5_000_000, limit: 50 });
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.every((i) => i.maxPricePaise >= 5_000_000)).toBe(true);
  });

  it('returns nothing for gibberish and for unknown or malformed categories', async () => {
    expect((await find('xyzzy qwerty')).total).toBe(0);
    expect((await find('', { category: 'no.such.category' })).total).toBe(0);
    expect((await find('', { category: "food'; DROP TABLE products; --" })).total).toBe(0);
  });

  it('pages through results without overlap', async () => {
    const first = await find('chocolate', { limit: 10 });
    const second = await find('chocolate', { limit: 10, offset: 10 });
    expect(second.total).toBe(first.total);
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(20);
  });
});
