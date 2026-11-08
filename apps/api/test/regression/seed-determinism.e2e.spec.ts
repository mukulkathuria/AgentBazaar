import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedProductId } from '../../src/modules/catalog/application/seed-ids.js';
import { createShopApp, type ShopApp } from '../support/shop.js';

// Regression (found by the screenshot baselines): each boot gave the seeded products new random ids, and search and
// "bought together" break ranking ties by product id, so the same catalog listed tied products in another order on
// every boot of the demo store.
describe('@lite regression: the seeded catalog is the same store on every boot', () => {
  let app: ShopApp;
  beforeAll(async () => {
    app = await createShopApp();
  });
  afterAll(async () => app.close());

  it('gives every seeded product the id derived from its slug', async () => {
    const products = await app.infra.database.query<{ id: string; slug: string }>('SELECT id, slug FROM products');
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) expect(p.id).toBe(seedProductId(p.slug));
  });
});
