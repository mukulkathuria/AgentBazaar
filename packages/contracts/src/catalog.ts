import { z } from 'zod';
import { Currency, Paise, Slug, Uuid } from './common.js';

export const PriceBand = z.enum(['fixed', 'standard', 'premium']);
export type PriceBand = z.infer<typeof PriceBand>;

/** Band thresholds in paise. Under ₹500 fixed, ₹500–₹20,000 standard, above premium. */
export const BAND_THRESHOLDS = { fixedBelow: 50_000, premiumAbove: 2_000_000 } as const;

export function bandForPrice(pricePaise: number): PriceBand {
  if (pricePaise < BAND_THRESHOLDS.fixedBelow) return 'fixed';
  if (pricePaise > BAND_THRESHOLDS.premiumAbove) return 'premium';
  return 'standard';
}

export const CategoryRef = z.object({ slug: z.string(), name: z.string(), path: z.string() });
export type CategoryRef = z.infer<typeof CategoryRef>;

export const PublicVariant = z.object({
  id: Uuid,
  sku: z.string(),
  title: z.string(),
  options: z.record(z.string(), z.string()),
  pricePaise: Paise,
  mrpPaise: Paise,
  currency: Currency,
  inStock: z.boolean(),
  /** Capped at 50 so exact stock is not disclosed to scrapers. */
  availableQty: z.number().int().min(0).max(50),
});
export type PublicVariant = z.infer<typeof PublicVariant>;

export const PublicProduct = z.object({
  id: Uuid,
  slug: Slug,
  name: z.string(),
  brand: z.string(),
  description: z.string(),
  category: CategoryRef,
  breadcrumbs: z.array(CategoryRef),
  band: PriceBand,
  customizable: z.boolean(),
  returnable: z.boolean(),
  returnWindowDays: z.number().int().min(0),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  images: z.array(z.string()),
  variants: z.array(PublicVariant).min(1),
  rating: z.object({ average: z.number().min(0).max(5), count: z.number().int().min(0) }).nullable(),
  faqs: z.array(z.object({ q: z.string(), a: z.string() })),
  updatedAt: z.string(),
});
export type PublicProduct = z.infer<typeof PublicProduct>;

export const ProductSummary = z.object({
  id: Uuid,
  slug: Slug,
  name: z.string(),
  brand: z.string(),
  categoryPath: z.string(),
  band: PriceBand,
  minPricePaise: Paise,
  maxPricePaise: Paise,
  inStock: z.boolean(),
  image: z.string().nullable(),
  customizable: z.boolean(),
  /** Default variant SKU, handy for agents that want to quote straight away. */
  defaultSku: z.string(),
});
export type ProductSummary = z.infer<typeof ProductSummary>;

export const SearchQuery = z.object({
  q: z.string().trim().max(200).default(''),
  category: z.string().trim().max(200).optional(),
  brand: z.string().trim().max(80).optional(),
  minPricePaise: z.coerce.number().int().min(0).optional(),
  maxPricePaise: z.coerce.number().int().min(0).optional(),
  inStockOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(false),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  offset: z.coerce.number().int().min(0).max(5_000).default(0),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const Facet = z.object({ value: z.string(), count: z.number().int() });
export const SearchResult = z.object({
  items: z.array(ProductSummary),
  total: z.number().int().min(0),
  facets: z.object({ brands: z.array(Facet), categories: z.array(Facet) }),
  tookMs: z.number(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const CategoryNode = z.object({
  slug: z.string(),
  name: z.string(),
  path: z.string(),
  depth: z.number().int(),
  productCount: z.number().int(),
});
export type CategoryNode = z.infer<typeof CategoryNode>;

export const Availability = z.object({
  sku: z.string(),
  inStock: z.boolean(),
  availableQty: z.number().int().min(0).max(50),
  canFulfilQuantity: z.boolean(),
  requestedQuantity: z.number().int(),
});
export type Availability = z.infer<typeof Availability>;

export const AttributeDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().max(80),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  required: z.boolean().default(false),
  values: z.array(z.string()).optional(),
  unit: z.string().max(16).optional(),
});
export type AttributeDef = z.infer<typeof AttributeDef>;

/** Admin input. Commercial secrets (cost, floor) are accepted here but never returned by public APIs. */
export const AdminVariantInput = z.strictObject({
  sku: z.string(),
  title: z.string().min(1).max(120),
  options: z.record(z.string(), z.string()).default({}),
  pricePaise: Paise,
  mrpPaise: Paise,
  costPricePaise: Paise,
  minMarginBps: z.number().int().min(0).max(10_000).default(1000),
  stock: z.number().int().min(0).max(1_000_000).default(0),
});
export const AdminProductInput = z.strictObject({
  slug: Slug,
  name: z.string().min(2).max(160),
  brand: z.string().min(1).max(80),
  description: z.string().max(5000),
  categoryPath: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/),
  hsnCode: z.string().regex(/^\d{4,8}$/),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  images: z.array(z.string().max(500)).max(10).default([]),
  returnWindowDays: z.number().int().min(0).max(90).default(7),
  customizationSchemaId: Uuid.nullable().default(null),
  variants: z.array(AdminVariantInput).min(1).max(200),
});
export type AdminProductInput = z.infer<typeof AdminProductInput>;
