import { AdminProductInput, SearchQuery, type SearchResult } from '@agentbazaar/contracts';
import { generateCatalog } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { InventoryService } from '../../src/modules/inventory/index.js';
import type { SearchPort } from '../../src/modules/search/application/ports.js';
import { SearchIndexer } from '../../src/modules/search/application/search-indexer.js';
import type { SearchQueryInput } from '../../src/modules/search/application/search.service.js';
import { HashEmbeddings } from '../../src/modules/search/domain/embeddings.js';
import { PgSearchAdapter } from '../../src/modules/search/infrastructure/pg-search.adapter.js';
import { inTransaction, one, type Executor } from '../../src/shared/db/database.js';
import { systemClock } from '../../src/shared/kernel/clock.js';
import { appendEvent, InProcessEventBus, OutboxRelay } from '../../src/shared/outbox/outbox.js';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { realEngines, type RealEngines } from './real-engines.js';

const PRODUCTS = 400;
const SLUG = 'zorbex-quantum-mug';
const MUG = AdminProductInput.parse({
  slug: SLUG,
  name: 'Zorbex Quantum Mug',
  brand: 'Zorbex',
  description: 'A heat-changing ceramic mug.',
  categoryPath: 'home.mugs',
  hsnCode: '6912',
  variants: [
    { sku: 'ZORBEX-QMUG-RED', title: 'Red', pricePaise: 59_900, mrpPaise: 69_900, costPricePaise: 30_000, stock: 5 },
    { sku: 'ZORBEX-QMUG-GOLD', title: 'Gold', pricePaise: 89_900, mrpPaise: 99_900, costPricePaise: 40_000, stock: 0 },
  ],
});

type Engine = 'postgres' | 'meilisearch' | 'opensearch';

describe('@growth @scale search engines on real Meilisearch, OpenSearch and Qdrant', () => {
  let t: TestDb;
  let db: Executor;
  let catalog: CatalogService;
  let inventory: InventoryService;
  let engines: RealEngines;
  let ports: Record<Engine, SearchPort>;
  const embeddings = new HashEmbeddings();
  const find = (port: SearchPort, input: SearchQueryInput): Promise<SearchResult> => port.search(SearchQuery.parse(input));
  const each = async (fn: (name: Engine, port: SearchPort) => Promise<void>) => {
    for (const [name, port] of Object.entries(ports) as [Engine, SearchPort][]) await fn(name, port);
  };

  beforeAll(async () => {
    t = await createTestDb({ poolMax: 6 });
    db = t.database.db;
    inventory = new InventoryService(db, systemClock);
    catalog = new CatalogService(db, inventory);
    await inTransaction(db, (tx) => catalog.importSeed(tx, generateCatalog({ products: PRODUCTS }), new Map()));
    engines = realEngines('engines', embeddings);
    ports = { postgres: new PgSearchAdapter(db, embeddings), meilisearch: engines.meilisearch, opensearch: engines.opensearch };
  }, 300_000);
  afterAll(async () => {
    await engines?.drop();
    await t?.cleanup();
  });

  it('reindexes every active product into each engine page by page, reporting progress', async () => {
    await each(async (name, port) => {
      const progress: number[] = [];
      expect(await new SearchIndexer(port, embeddings, catalog).reindexAll(150, (n) => progress.push(n)), name).toBe(PRODUCTS);
      expect(progress, name).toEqual([150, 300, PRODUCTS]);
    });
    await engines.settle();
    await each(async (name, port) => expect(await port.count(), name).toBe(PRODUCTS));
  });

  it('follows product, variant and stock changes from the outbox in every engine', async () => {
    const bus = new InProcessEventBus(db);
    await each(async (name, port) =>
      bus.subscribe({ ...new SearchIndexer(port, embeddings, catalog).subscription(), consumer: `search-indexer:${name}` }),
    );
    const relay = new OutboxRelay(db, bus);
    const sync = async () => {
      await relay.drain();
      await engines.settle();
    };
    const mug = (r: SearchResult) => r.items.find((i) => i.slug === SLUG);

    await catalog.upsertProduct(MUG, 'admin:test');
    await sync();
    await each(async (name, port) => {
      expect((await find(port, { q: 'zorbex quantum' })).items[0], name).toMatchObject({
        slug: SLUG,
        minPricePaise: 59_900,
        maxPricePaise: 89_900,
        defaultSku: 'ZORBEX-QMUG-RED',
        inStock: true,
      });
      // Every variant's SKU finds the product, and price filters overlap the variants' price range.
      expect((await find(port, { q: 'ZORBEX-QMUG-GOLD' })).items[0]?.slug, name).toBe(SLUG);
      expect(mug(await find(port, { q: 'zorbex', minPricePaise: 80_000 })), name).toBeDefined();
      expect(mug(await find(port, { q: 'zorbex', maxPricePaise: 50_000 })), name).toBeUndefined();
    });

    const red = (await catalog.findVariant('ZORBEX-QMUG-RED'))!;
    await inTransaction(db, (tx) => inventory.setStock(tx, red.variantId, 0));
    await sync();
    await each(async (name, port) => {
      expect(mug(await find(port, { q: 'zorbex' }))?.inStock, name).toBe(false);
      expect(mug(await find(port, { q: 'zorbex', inStockOnly: true })), name).toBeUndefined();
    });

    await catalog.upsertProduct({ ...MUG, name: 'Zorbex Thermo Mug' }, 'admin:test');
    await sync();
    await each(async (name, port) => expect((await find(port, { q: 'zorbex thermo' })).items[0], name).toMatchObject({ slug: SLUG, name: 'Zorbex Thermo Mug' }));

    const { id } = (await one<{ id: string }>(db, sql`SELECT id FROM products WHERE slug = ${SLUG}`))!;
    await inTransaction(db, async (tx) => {
      await tx.execute(sql`UPDATE products SET status = 'archived' WHERE id = ${id}`);
      await appendEvent(tx, 'catalog.product_upserted', id, { productId: id });
    });
    await sync();
    await each(async (name, port) => {
      expect(mug(await find(port, { q: 'zorbex' })), name).toBeUndefined();
      expect(await port.count(), name).toBe(PRODUCTS);
    });
  });

  it.each<SearchQueryInput>([
    {},
    { category: 'food' },
    { category: 'electronics.accessories' },
    { brand: 'kagaz' },
    { inStockOnly: true },
    { minPricePaise: 100_000, maxPricePaise: 500_000 },
    { category: 'apparel', inStockOnly: true, maxPricePaise: 60_000 },
  ])('browsing with %j gives the same totals, facets and pages as Postgres', async (filters) => {
    const browse = async (port: SearchPort) => {
      const first = await find(port, { ...filters, limit: 50 });
      const ids = first.items.map((i) => i.id);
      for (let n = first.items.length; n === 50; ) {
        const page = await find(port, { ...filters, limit: 50, offset: ids.length });
        ids.push(...page.items.map((i) => i.id));
        n = page.items.length;
      }
      return { first, ids };
    };
    const expected = await browse(ports.postgres);
    expect(expected.first.total).toBeGreaterThan(0);
    for (const name of ['meilisearch', 'opensearch'] as const) {
      const got = await browse(ports[name]);
      expect(got.first.total, name).toBe(expected.first.total);
      expect(got.first.facets, name).toEqual(expected.first.facets);
      expect(new Set(got.ids).size, `${name} pages overlap`).toBe(got.ids.length);
      expect(new Set(got.ids), name).toEqual(new Set(expected.ids));
    }
  });

  it('applies every filter to text queries and finds nothing for gibberish or unknown categories', async () => {
    await each(async (name, port) => {
      const r = await find(port, { q: 'chocolate', category: 'food', brand: 'Mithas', minPricePaise: 1000, maxPricePaise: 50_000, inStockOnly: true, limit: 50 });
      expect(r.items.length, name).toBeGreaterThan(0);
      expect(r.total, name).toBeGreaterThanOrEqual(r.items.length);
      for (const i of r.items) {
        expect(i, name).toMatchObject({ brand: 'Mithas', inStock: true });
        expect(i.categoryPath.startsWith('food.') && i.maxPricePaise >= 1000 && i.minPricePaise <= 50_000, `${name} ${i.slug}`).toBe(true);
      }
      expect((await find(port, { q: 'xyzzy qwerty' })).total, name).toBe(0);
      expect((await find(port, { q: '', category: 'no.such.category' })).total, name).toBe(0);
    });
  });

  it('pages through products with tied scores and tied names without repeating or skipping one', { timeout: 300_000 }, async () => {
    // Thirty products the engines cannot tell apart: same name, brand, category and description, one SKU each.
    const slugs = Array.from({ length: 30 }, (_, i) => `zorvex-tiebreak-mug-${i}`);
    const ids: string[] = [];
    for (const [i, slug] of slugs.entries()) {
      const variant = { sku: `ZTB-${i}`, title: 'Standard', pricePaise: 50_000, mrpPaise: 60_000, costPricePaise: 20_000, stock: 5 };
      const p = AdminProductInput.parse({ ...MUG, slug, name: 'Zorvex Tiebreak Mug', brand: 'Zorvex', description: 'A plain test mug.', variants: [variant] });
      ids.push((await catalog.upsertProduct(p, 'admin:test')).id);
    }
    await each(async (_name, port) => {
      const indexer = new SearchIndexer(port, embeddings, catalog);
      for (const id of ids) await indexer.indexProduct(id);
    });
    await engines.settle();
    const pages = async (port: SearchPort, query: SearchQueryInput) => {
      const seen: string[] = [];
      for (let offset = 0; offset < 30; offset += 7) seen.push(...(await find(port, { ...query, limit: 7, offset })).items.map((i) => i.slug));
      return seen.slice(0, 30);
    };
    await each(async (name, port) => {
      for (const query of [{ q: 'tiebreak' }, { q: '', brand: 'Zorvex' }]) {
        const first = await pages(port, query);
        expect(new Set(first).size, `${name} ${query.q || 'browse'}: no product twice`).toBe(30);
        expect(new Set(first), `${name} ${query.q || 'browse'}: no product skipped`).toEqual(new Set(slugs));
        expect(await pages(port, query), `${name} ${query.q || 'browse'}: the same order every time`).toEqual(first);
      }
    });
  });
});
