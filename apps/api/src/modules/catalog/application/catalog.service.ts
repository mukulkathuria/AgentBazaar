import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminProductInput,
  type Availability,
  type CategoryNode,
  type CategoryRef,
  type PriceBand,
  type ProductSummary,
  type PublicProduct,
} from '@agentbazaar/contracts';
import type { SeedCatalog } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { json, pgArray } from '../../../shared/db/sql-helpers.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { DB, READ_DB } from '../../../shared/kernel/tokens.js';
import { appendEvent } from '../../../shared/outbox/outbox.js';
import { displayQty, InventoryService } from '../../inventory/index.js';
import { floorPaise, productBand, type LandedCost } from '../domain/commercial.js';
import { seedProductId } from './seed-ids.js';

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  brand: string;
  description: string;
  band: PriceBand;
  hsn_code: string;
  product_type: string;
  attributes: Record<string, string | number | boolean>;
  images: string[];
  faqs: { q: string; a: string }[];
  return_window_days: number;
  customization_schema_id: string | null;
  rating_avg: number | null;
  rating_count: number;
  updated_at: Date;
  category_path: string;
  category_name: string;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  options: Record<string, string>;
  price_paise: number;
  mrp_paise: number;
}

/** What other modules may know about a variant. Commercial secrets are deliberately absent. */
export interface VariantRef {
  variantId: string;
  productId: string;
  sku: string;
  title: string;
  productName: string;
  productSlug: string;
  productType: string;
  pricePaise: number;
  mrpPaise: number;
  band: PriceBand;
  hsnCode: string;
  returnWindowDays: number;
  customizationSchemaId: string | null;
}

/** Internal only, for the pricing policy engine. Never serialised to any client or prompt. */
export interface PricingSnapshot {
  variantId: string;
  listUnitPaise: number;
  mrpPaise: number;
  floorUnitPaise: number;
  band: PriceBand;
}

export interface SearchSource {
  productId: string;
  slug: string;
  name: string;
  brand: string;
  categoryPath: string;
  categoryName: string;
  description: string;
  skus: string[];
  defaultSku: string;
  band: PriceBand;
  minPricePaise: number;
  maxPricePaise: number;
  inStock: boolean;
  image: string | null;
  customizable: boolean;
}

const lastLabel = (path: string) => path.split('.').pop() ?? path;
const toCategoryRef = (path: string, name: string): CategoryRef => ({ slug: lastLabel(path), name, path });

const PRODUCT_SELECT = sql`
  SELECT p.id, p.slug, p.name, b.name AS brand, p.description, p.band, p.hsn_code, p.product_type, p.attributes, p.images,
         p.faqs, p.return_window_days, p.customization_schema_id, p.rating_avg, p.rating_count, p.updated_at,
         c.path::text AS category_path, c.name AS category_name
  FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id`;

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    /** Storefront reads only (product pages, categories, feed, summaries): a replica in growth. */
    @Inject(READ_DB) private readonly reads: Executor = db,
  ) {}

  private async variantsOf(productIds: readonly string[], ex: Executor = this.db): Promise<VariantRow[]> {
    if (!productIds.length) return [];
    return rows<VariantRow>(
      ex,
      sql`SELECT id, product_id, sku, title, options, price_paise, mrp_paise FROM variants
          WHERE product_id = ANY(${pgArray(productIds, 'uuid')}) ORDER BY position, sku`,
    );
  }

  private async breadcrumbs(path: string): Promise<CategoryRef[]> {
    const crumbs = await rows<{ path: string; name: string }>(
      this.reads,
      sql`SELECT path::text AS path, name FROM categories WHERE path @> ${path}::ltree ORDER BY nlevel(path)`,
    );
    return crumbs.map((c) => toCategoryRef(c.path, c.name));
  }

  private async toPublic(p: ProductRow, variants: VariantRow[]): Promise<PublicProduct> {
    // Display only: reservations and checkout re-check stock on the primary.
    const avail = await this.inventory.availability(
      variants.map((v) => v.id),
      this.reads,
    );
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      brand: p.brand,
      description: p.description,
      category: toCategoryRef(p.category_path, p.category_name),
      breadcrumbs: await this.breadcrumbs(p.category_path),
      band: p.band,
      customizable: p.customization_schema_id !== null,
      returnable: p.return_window_days > 0,
      returnWindowDays: p.return_window_days,
      attributes: p.attributes,
      images: p.images,
      variants: variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        options: v.options,
        pricePaise: v.price_paise,
        mrpPaise: v.mrp_paise,
        currency: 'INR',
        inStock: (avail.get(v.id) ?? 0) > 0,
        availableQty: displayQty(avail.get(v.id) ?? 0),
      })),
      rating: p.rating_avg === null ? null : { average: Math.round(p.rating_avg * 10) / 10, count: p.rating_count },
      faqs: p.faqs,
      updatedAt: p.updated_at.toISOString(),
    };
  }

  async getProduct(slug: string): Promise<PublicProduct> {
    const p = await one<ProductRow>(this.reads, sql`${PRODUCT_SELECT} WHERE p.slug = ${slug} AND p.status = 'active'`);
    if (!p) throw notFound('Product');
    return this.toPublic(p, await this.variantsOf([p.id], this.reads));
  }

  async getProductById(id: string): Promise<PublicProduct | null> {
    const p = await one<ProductRow>(this.reads, sql`${PRODUCT_SELECT} WHERE p.id = ${id} AND p.status = 'active'`);
    return p ? this.toPublic(p, await this.variantsOf([p.id], this.reads)) : null;
  }

  /** Resolves a product slug or a variant SKU (agents use either). */
  async resolve(slugOrSku: string): Promise<PublicProduct> {
    const bySku = await one<{ slug: string }>(
      this.reads,
      sql`SELECT p.slug FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ${slugOrSku.trim().toUpperCase()}`,
    );
    return this.getProduct(bySku?.slug ?? slugOrSku.trim().toLowerCase());
  }

  async findVariant(skuOrId: string, ex: Executor = this.db): Promise<VariantRef | null> {
    // A fixed-length character class runs in linear time; njsscan mistakes (skuOrId, ex) for (req, res).
    const isUuid = /^[0-9a-f-]{36}$/i.test(skuOrId); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    const r = await one<VariantRow & ProductRow & { variant_id: string }>(
      ex,
      sql`SELECT v.id AS variant_id, v.sku, v.title, v.price_paise, v.mrp_paise, p.id, p.slug, p.name, p.product_type, p.band,
                 p.hsn_code, p.return_window_days, p.customization_schema_id
          FROM variants v JOIN products p ON p.id = v.product_id
          WHERE ${isUuid ? sql`v.id = ${skuOrId}` : sql`v.sku = ${skuOrId.trim().toUpperCase()}`} AND p.status = 'active'`,
    );
    if (!r) return null;
    return {
      variantId: r.variant_id,
      productId: r.id,
      sku: r.sku,
      title: r.title,
      productName: r.name,
      productSlug: r.slug,
      productType: r.product_type,
      pricePaise: r.price_paise,
      mrpPaise: r.mrp_paise,
      band: r.band,
      hsnCode: r.hsn_code,
      returnWindowDays: r.return_window_days,
      customizationSchemaId: r.customization_schema_id,
    };
  }

  async requireVariant(skuOrId: string, ex: Executor = this.db): Promise<VariantRef> {
    const v = await this.findVariant(skuOrId, ex);
    if (!v) throw notFound(`SKU ${skuOrId}`);
    return v;
  }

  async pricingSnapshot(variantId: string, ex: Executor = this.db): Promise<PricingSnapshot> {
    const r = await one<{
      price_paise: number;
      mrp_paise: number;
      cost_price_paise: number;
      landed_cost: LandedCost;
      min_margin_bps: number;
      band: PriceBand;
    }>(
      ex,
      sql`SELECT v.price_paise, v.mrp_paise, v.cost_price_paise, v.landed_cost, v.min_margin_bps, p.band
          FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ${variantId}`,
    );
    if (!r) throw notFound('Variant');
    return {
      variantId,
      listUnitPaise: r.price_paise,
      mrpPaise: r.mrp_paise,
      floorUnitPaise: floorPaise(r.cost_price_paise, r.landed_cost, r.min_margin_bps),
      band: r.band,
    };
  }

  async availabilityFor(sku: string, quantity: number): Promise<Availability> {
    const v = await this.requireVariant(sku);
    const available = (await this.inventory.availability([v.variantId])).get(v.variantId) ?? 0;
    return {
      sku: v.sku,
      inStock: available > 0,
      availableQty: displayQty(available),
      canFulfilQuantity: available >= quantity,
      requestedQuantity: quantity,
    };
  }

  async listCategories(): Promise<CategoryNode[]> {
    const r = await rows<{ path: string; name: string; depth: number; product_count: number }>(
      this.reads,
      sql`SELECT c.path::text AS path, c.name, nlevel(c.path) AS depth,
                 (SELECT count(*)::int FROM products p JOIN categories c2 ON c2.id = p.category_id
                  WHERE c2.path <@ c.path AND p.status = 'active') AS product_count
          FROM categories c ORDER BY c.path`,
    );
    return r.map((c) => ({ slug: lastLabel(c.path), name: c.name, path: c.path, depth: c.depth, productCount: c.product_count }));
  }

  async searchSource(productId: string, ex: Executor = this.db): Promise<SearchSource | null> {
    return (await this.searchSources([productId], ex))[0] ?? null;
  }

  /** Search documents for a page of products in three queries; inactive, unknown and variant-less ones are left out. */
  async searchSources(productIds: readonly string[], ex: Executor = this.db): Promise<SearchSource[]> {
    if (!productIds.length) return [];
    const ps = await rows<ProductRow>(
      ex,
      sql`${PRODUCT_SELECT} WHERE p.id = ANY(${pgArray(productIds, 'uuid')}) AND p.status = 'active' ORDER BY p.id`,
    );
    const all = await this.variantsOf(
      ps.map((p) => p.id),
      ex,
    );
    const avail = await this.inventory.availability(
      all.map((v) => v.id),
      ex,
    );
    const byProduct = new Map<string, VariantRow[]>();
    for (const v of all) {
      const list = byProduct.get(v.product_id);
      if (list) list.push(v);
      else byProduct.set(v.product_id, [v]);
    }
    return ps.flatMap((p) => {
      const variants = byProduct.get(p.id);
      if (!variants) return [];
      const prices = variants.map((v) => v.price_paise);
      return {
        productId: p.id,
        slug: p.slug,
        name: p.name,
        brand: p.brand,
        categoryPath: p.category_path,
        categoryName: p.category_name,
        description: p.description,
        skus: variants.map((v) => v.sku),
        defaultSku: variants[0]!.sku,
        band: p.band,
        minPricePaise: Math.min(...prices),
        maxPricePaise: Math.max(...prices),
        inStock: variants.some((v) => (avail.get(v.id) ?? 0) > 0),
        image: p.images[0] ?? null,
        customizable: p.customization_schema_id !== null,
      };
    });
  }

  async productIdForVariant(variantId: string, ex: Executor = this.db): Promise<string | null> {
    const r = await one<{ product_id: string }>(ex, sql`SELECT product_id FROM variants WHERE id = ${variantId}`);
    return r?.product_id ?? null;
  }

  async productIdsPage(afterId: string | null, limit: number): Promise<string[]> {
    const r = await rows<{ id: string }>(
      this.db,
      sql`SELECT id FROM products WHERE status = 'active' ${afterId ? sql`AND id > ${afterId}` : sql``} ORDER BY id LIMIT ${limit}`,
    );
    return r.map((x) => x.id);
  }

  async productIdsBySlugs(slugs: readonly string[]): Promise<Map<string, string>> {
    if (!slugs.length) return new Map();
    const r = await rows<{ id: string; slug: string }>(
      this.reads,
      sql`SELECT id, slug FROM products WHERE slug = ANY(${pgArray(slugs, 'text')})`,
    );
    return new Map(r.map((x) => [x.slug, x.id]));
  }

  async feed(limit: number, offset: number): Promise<PublicProduct[]> {
    const ps = await rows<ProductRow>(
      this.reads,
      sql`${PRODUCT_SELECT} WHERE p.status = 'active' ORDER BY p.slug LIMIT ${limit} OFFSET ${offset}`,
    );
    const variants = await this.variantsOf(
      ps.map((p) => p.id),
      this.reads,
    );
    return Promise.all(ps.map((p) => this.toPublic(p, variants.filter((v) => v.product_id === p.id))));
  }

  /** Lightweight summaries for listings, search hits and recommendations, in the order given. */
  async summaries(productIds: readonly string[]): Promise<ProductSummary[]> {
    const sources = await Promise.all(productIds.map((id) => this.searchSource(id, this.reads)));
    return sources.filter((s): s is SearchSource => s !== null).map(toSummary);
  }

  async upsertProduct(input: AdminProductInput, actor: string): Promise<PublicProduct> {
    const productId = await inTransaction(this.db, async (tx) => {
      const category = await one<{ id: string }>(tx, sql`SELECT id FROM categories WHERE path = ${input.categoryPath}::ltree`);
      if (!category) throw new AppError('validation_failed', `Unknown category ${input.categoryPath}`);
      const brand = await one<{ id: string }>(
        tx,
        sql`INSERT INTO brands (name, slug) VALUES (${input.brand}, ${slugify(input.brand)})
            ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      );
      for (const v of input.variants) {
        if (v.mrpPaise < v.pricePaise) throw new AppError('validation_failed', `Price of ${v.sku} exceeds its MRP`);
      }
      const band = productBand(input.variants.map((v) => v.pricePaise));
      const product = await one<{ id: string }>(
        tx,
        sql`INSERT INTO products (slug, name, brand_id, category_id, description, band, hsn_code, attributes, images,
                                  return_window_days, customization_schema_id)
            VALUES (${input.slug}, ${input.name}, ${brand!.id}, ${category.id}, ${input.description}, ${band}, ${input.hsnCode},
                    ${json(input.attributes)}, ${json(input.images)}, ${input.returnWindowDays}, ${input.customizationSchemaId})
            ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, brand_id = EXCLUDED.brand_id, category_id = EXCLUDED.category_id,
              description = EXCLUDED.description, band = EXCLUDED.band, hsn_code = EXCLUDED.hsn_code,
              attributes = EXCLUDED.attributes, images = EXCLUDED.images, return_window_days = EXCLUDED.return_window_days,
              customization_schema_id = EXCLUDED.customization_schema_id, updated_at = now()
            RETURNING id`,
      );
      for (const [i, v] of input.variants.entries()) {
        const sku = v.sku.trim().toUpperCase();
        const prev = await one<{ price_paise: number }>(tx, sql`SELECT price_paise FROM variants WHERE sku = ${sku}`);
        const row = await one<{ id: string }>(
          tx,
          sql`INSERT INTO variants (product_id, sku, title, options, price_paise, mrp_paise, cost_price_paise, min_margin_bps, position)
              VALUES (${product!.id}, ${sku}, ${v.title}, ${json(v.options)}, ${v.pricePaise}, ${v.mrpPaise}, ${v.costPricePaise},
                      ${v.minMarginBps}, ${i})
              ON CONFLICT (sku) DO UPDATE SET title = EXCLUDED.title, options = EXCLUDED.options, price_paise = EXCLUDED.price_paise,
                mrp_paise = EXCLUDED.mrp_paise, cost_price_paise = EXCLUDED.cost_price_paise,
                min_margin_bps = EXCLUDED.min_margin_bps, position = EXCLUDED.position, updated_at = now()
              WHERE variants.product_id = EXCLUDED.product_id
              RETURNING id`,
        );
        if (!row) throw new AppError('conflict', `SKU ${sku} belongs to another product`);
        if (!prev || prev.price_paise !== v.pricePaise) {
          await tx.execute(sql`INSERT INTO price_history (variant_id, price_paise) VALUES (${row.id}, ${v.pricePaise})`);
        }
        await this.inventory.setStock(tx, row.id, v.stock);
      }
      await appendEvent(tx, 'catalog.product_upserted', product!.id, { productId: product!.id, actor });
      return product!.id;
    });
    return (await this.getProductById(productId))!;
  }

  /** Bulk seed import (synthetic catalog). Chunked multi-row inserts keep 10k products fast. */
  async importSeed(
    tx: Executor,
    seed: Pick<SeedCatalog, 'categories' | 'products'>,
    schemaIds: Map<string, string>,
  ): Promise<Map<string, string>> {
    for (const c of seed.categories) {
      await tx.execute(
        sql`INSERT INTO categories (path, name, name_hi) VALUES (${c.path}::ltree, ${c.name}, ${c.nameHi}) ON CONFLICT (path) DO NOTHING`,
      );
    }
    for (const b of new Set(seed.products.map((p) => p.brand))) {
      await tx.execute(sql`INSERT INTO brands (name, slug) VALUES (${b}, ${slugify(b)}) ON CONFLICT (name) DO NOTHING`);
    }
    const brandIds = new Map((await rows<{ id: string; name: string }>(tx, sql`SELECT id, name FROM brands`)).map((b) => [b.name, b.id]));
    const catIds = new Map(
      (await rows<{ id: string; path: string }>(tx, sql`SELECT id, path::text AS path FROM categories`)).map((c) => [c.path, c.id]),
    );
    const productIds = new Map<string, string>();
    for (let i = 0; i < seed.products.length; i += 400) {
      const chunk = seed.products.slice(i, i + 400);
      const inserted = await rows<{ id: string; slug: string }>(
        tx,
        sql`INSERT INTO products (id, slug, name, brand_id, category_id, description, band, hsn_code, product_type, attributes, faqs,
                                  return_window_days, customization_schema_id, rating_avg, rating_count)
            VALUES ${sql.join(
              chunk.map(
                (p) => sql`(${seedProductId(p.slug)}, ${p.slug}, ${p.name}, ${brandIds.get(p.brand)!}, ${catIds.get(p.categoryPath)!}, ${p.description},
                  ${productBand(p.variants.map((v) => v.pricePaise))}, ${p.hsnCode}, ${p.productType}, ${json(p.attributes)},
                  ${json(p.faqs)}, ${p.returnWindowDays}, ${p.customizationSchema ? (schemaIds.get(p.customizationSchema) ?? null) : null},
                  ${p.rating?.average ?? null}, ${p.rating?.count ?? 0})`,
              ),
              sql`, `,
            )}
            ON CONFLICT (slug) DO NOTHING RETURNING id, slug`,
      );
      for (const r of inserted) productIds.set(r.slug, r.id);
      const variants = chunk.flatMap((p) => (productIds.has(p.slug) ? p.variants.map((v, pos) => ({ p, v, pos })) : []));
      for (let j = 0; j < variants.length; j += 500) {
        const vchunk = variants.slice(j, j + 500);
        const vrows = await rows<{ id: string; sku: string }>(
          tx,
          sql`INSERT INTO variants (product_id, sku, title, options, price_paise, mrp_paise, cost_price_paise, landed_cost,
                                    min_margin_bps, supplier, lead_time_days, position)
              VALUES ${sql.join(
                vchunk.map(
                  ({ p, v, pos }) => sql`(${productIds.get(p.slug)!}, ${v.sku}, ${v.title}, ${json(v.options)}, ${v.pricePaise},
                    ${v.mrpPaise}, ${v.costPricePaise}, ${json(v.landedCost)}, ${v.minMarginBps}, ${v.supplier}, ${v.leadTimeDays}, ${pos})`,
                ),
                sql`, `,
              )}
              RETURNING id, sku`,
        );
        const stockBySku = new Map(vchunk.map(({ v }) => [v.sku, v.stock]));
        await tx.execute(
          sql`INSERT INTO stock_levels (variant_id, on_hand) VALUES ${sql.join(
            vrows.map((r) => sql`(${r.id}, ${stockBySku.get(r.sku) ?? 0})`),
            sql`, `,
          )} ON CONFLICT (variant_id) DO NOTHING`,
        );
        await tx.execute(
          sql`INSERT INTO price_history (variant_id, price_paise)
              SELECT id, price_paise FROM variants WHERE id = ANY(${pgArray(
                vrows.map((r) => r.id),
                'uuid',
              )})`,
        );
      }
    }
    return productIds;
  }
}

export function toSummary(s: SearchSource): ProductSummary {
  return {
    id: s.productId,
    slug: s.slug,
    name: s.name,
    brand: s.brand,
    categoryPath: s.categoryPath,
    band: s.band,
    minPricePaise: s.minPricePaise,
    maxPricePaise: s.maxPricePaise,
    inStock: s.inStock,
    image: s.image,
    customizable: s.customizable,
    defaultSku: s.defaultSku,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
