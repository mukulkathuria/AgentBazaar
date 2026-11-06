import { AdminProductInput } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '../../src/modules/catalog/application/catalog.service.js';
import { createShopApp, type ShopApp } from '../support/shop.js';

/** Admin product upserts and the catalog lookups the HTTP suites skip. */
describe('@lite catalog service', () => {
  let app: ShopApp;
  let catalog: CatalogService;
  const q = <T>(text: string, params: unknown[] = []) => app.infra.database.query<T>(text, params);
  const product = (over: Partial<AdminProductInput> = {}, variant: Partial<AdminProductInput['variants'][number]> = {}) =>
    AdminProductInput.parse({
      slug: 'chai-flask-500',
      name: 'Chai Flask 500 ml',
      brand: 'Kettle & Co',
      description: 'Keeps chai hot for six hours.',
      categoryPath: 'home.mugs',
      hsnCode: '7323',
      variants: [{ sku: 'chai-flask-500', title: 'Steel', pricePaise: 89_900, mrpPaise: 99_900, costPricePaise: 50_000, stock: 12, ...variant }],
      ...over,
    });
  const history = async (sku: string) =>
    (await q<{ price_paise: number }>(
      'SELECT h.price_paise FROM price_history h JOIN variants v ON v.id = h.variant_id WHERE v.sku = $1 ORDER BY h.id',
      [sku],
    )).map((r) => r.price_paise);

  beforeAll(async () => {
    app = await createShopApp();
    catalog = app.app.get(CatalogService);
  }, 120_000);
  afterAll(async () => app.close());

  it('creates a product with upper-cased SKUs, stock, price history and an event', async () => {
    const created = await catalog.upsertProduct(product(), 'admin:1');
    expect(created).toMatchObject({ slug: 'chai-flask-500', name: 'Chai Flask 500 ml', band: 'standard' });
    expect(created.variants.map((v) => [v.sku, v.pricePaise, v.inStock])).toEqual([['CHAI-FLASK-500', 89_900, true]]);
    expect(await history('CHAI-FLASK-500')).toEqual([89_900]);
    const [event] = await q<{ payload: { actor: string } }>(
      `SELECT payload FROM outbox_events WHERE topic = 'catalog.product_upserted' AND aggregate_id = $1`,
      [created.id],
    );
    expect(event!.payload.actor).toBe('admin:1');
  });

  it('records a price only when it changes', async () => {
    await catalog.upsertProduct(product({ name: 'Chai Flask 500 ml (steel)' }), 'admin:1');
    expect(await history('CHAI-FLASK-500')).toEqual([89_900]);
    const repriced = await catalog.upsertProduct(product({}, { pricePaise: 84_900 }), 'admin:1');
    expect(repriced.variants[0]!.pricePaise).toBe(84_900);
    expect(await history('CHAI-FLASK-500')).toEqual([89_900, 84_900]);
  });

  it('refuses unknown categories, prices above MRP and SKUs owned by another product', async () => {
    await expect(catalog.upsertProduct(product({ categoryPath: 'home.teapots' }), 'admin:1')).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Unknown category home.teapots',
    });
    await expect(catalog.upsertProduct(product({}, { mrpPaise: 80_000 }), 'admin:1')).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Price of chai-flask-500 exceeds its MRP',
    });
    await expect(catalog.upsertProduct(product({ slug: 'keyboard-copy' }, { sku: 'THOCK-TK87-RED' }), 'admin:1')).rejects.toMatchObject({
      code: 'conflict',
      message: 'SKU THOCK-TK87-RED belongs to another product',
    });
    // Nothing from the refused attempts was written.
    expect((await catalog.productIdsBySlugs(['keyboard-copy'])).size).toBe(0);
  });

  it('answers empty lookups without querying and pages the feed by slug', async () => {
    expect(await catalog.searchSources([])).toEqual([]);
    expect((await catalog.productIdsBySlugs([])).size).toBe(0);
    const ids = await catalog.productIdsBySlugs(['chai-flask-500', 'no-such-product']);
    expect([...ids.keys()]).toEqual(['chai-flask-500']);
    const first = await catalog.feed(3, 0);
    const second = await catalog.feed(3, 3);
    expect(first.map((p) => p.slug)).toEqual([...first.map((p) => p.slug)].sort());
    expect(second[0]!.slug > first[2]!.slug).toBe(true);
    await expect(catalog.pricingSnapshot('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
  });
});
