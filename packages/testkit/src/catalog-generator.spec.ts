import { describe, expect, it } from 'vitest';
import { bandForPrice, Sku, Slug } from '@agentbazaar/contracts';
import { generateCatalog, heroProducts } from './catalog-generator.js';

describe('@lite synthetic catalog generator', () => {
  const catalog = generateCatalog({ products: 2000, seed: 42 });
  const variants = catalog.products.flatMap((p) => p.variants);

  it('is deterministic for a seed', () => {
    const again = generateCatalog({ products: 2000, seed: 42 });
    expect(again.products.map((p) => p.slug)).toEqual(catalog.products.map((p) => p.slug));
    expect(generateCatalog({ products: 2000, seed: 7 }).products[50]!.slug).not.toBe(catalog.products[50]!.slug);
  });

  it('produces the requested count with heroes first', () => {
    expect(catalog.products).toHaveLength(2000);
    expect(catalog.products.slice(0, heroProducts().length).map((p) => p.slug)).toEqual(heroProducts().map((p) => p.slug));
  });

  it('has unique, well-formed slugs and SKUs', () => {
    expect(new Set(catalog.products.map((p) => p.slug)).size).toBe(catalog.products.length);
    expect(new Set(variants.map((v) => v.sku)).size).toBe(variants.length);
    for (const p of catalog.products) expect(Slug.safeParse(p.slug).success, p.slug).toBe(true);
    for (const v of variants) expect(Sku.safeParse(v.sku).success, v.sku).toBe(true);
  });

  it('respects commercial invariants: cost < price <= MRP', () => {
    for (const v of variants) {
      expect(v.pricePaise).toBeGreaterThan(0);
      expect(v.mrpPaise).toBeGreaterThanOrEqual(v.pricePaise);
      expect(v.costPricePaise).toBeLessThan(v.pricePaise);
    }
  });

  it('spans every price band from a ₹20 chocolate to a ₹1 lakh GPU', () => {
    const prices = variants.map((v) => v.pricePaise);
    expect(Math.min(...prices)).toBe(2000);
    expect(Math.max(...prices)).toBe(10_000_000);
    expect(new Set(prices.map(bandForPrice))).toEqual(new Set(['fixed', 'standard', 'premium']));
  });

  it('only references known categories, schemas and products', () => {
    const paths = new Set(catalog.categories.map((c) => c.path));
    const schemas = new Set(catalog.customizationSchemas.map((s) => s.name));
    const slugs = new Set(catalog.products.map((p) => p.slug));
    for (const p of catalog.products) {
      expect(paths.has(p.categoryPath)).toBe(true);
      if (p.customizationSchema) expect(schemas.has(p.customizationSchema)).toBe(true);
    }
    for (const e of catalog.edges) {
      expect(slugs.has(e.from) && slugs.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
    for (const c of catalog.categories) {
      const parent = c.path.split('.').slice(0, -1).join('.');
      if (parent) expect(paths.has(parent), c.path).toBe(true);
    }
  });

  it('links GPUs only to power supplies with enough wattage', () => {
    const bySlug = new Map(catalog.products.map((p) => [p.slug, p]));
    const psuEdges = catalog.edges.filter((e) => e.kind === 'compatible_with' && bySlug.get(e.to)?.productType === 'psu');
    expect(psuEdges.length).toBeGreaterThan(0);
    for (const e of psuEdges) {
      expect(Number(bySlug.get(e.to)!.attributes.watts)).toBeGreaterThanOrEqual(
        Number(bySlug.get(e.from)!.attributes.recommended_psu_watts),
      );
    }
  });

  it('scales to the 10,000-product benchmark catalog', () => {
    const big = generateCatalog({ products: 10_000 });
    expect(big.products).toHaveLength(10_000);
    const skus = big.products.flatMap((p) => p.variants.map((v) => v.sku));
    expect(new Set(skus).size).toBe(skus.length);
  });
});
