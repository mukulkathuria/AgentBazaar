import type { PriceBand, ProductSummary } from '@agentbazaar/contracts';
import type { SearchDocument } from '../application/ports.js';

/** Flat document stored by Meilisearch, OpenSearch and Qdrant (as payload). */
export interface EngineDoc {
  id: string;
  slug: string;
  name: string;
  brand: string;
  brand_lc: string;
  category_path: string;
  /** Every ancestor path, so a "food" filter matches "food.chocolates" like ltree's <@ does. */
  category_paths: string[];
  category_top: string;
  category_name: string;
  description: string;
  skus: string[];
  default_sku: string;
  band: PriceBand;
  min_price_paise: number;
  max_price_paise: number;
  in_stock: boolean;
  image: string | null;
  customizable: boolean;
}

export function toEngineDoc(d: SearchDocument): EngineDoc {
  const labels = d.categoryPath.split('.');
  return {
    id: d.productId,
    slug: d.slug,
    name: d.name,
    brand: d.brand,
    brand_lc: d.brand.toLowerCase(),
    category_path: d.categoryPath,
    category_paths: labels.map((_, i) => labels.slice(0, i + 1).join('.')),
    category_top: labels[0]!,
    category_name: d.categoryName,
    description: d.description,
    skus: d.skus,
    default_sku: d.defaultSku,
    band: d.band,
    min_price_paise: d.minPricePaise,
    max_price_paise: d.maxPricePaise,
    in_stock: d.inStock,
    image: d.image,
    customizable: d.customizable,
  };
}

export const fromEngineDoc = (e: EngineDoc): ProductSummary => ({
  id: e.id,
  slug: e.slug,
  name: e.name,
  brand: e.brand,
  categoryPath: e.category_path,
  band: e.band,
  minPricePaise: e.min_price_paise,
  maxPricePaise: e.max_price_paise,
  inStock: e.in_stock,
  image: e.image,
  customizable: e.customizable,
  defaultSku: e.default_sku,
});

/** `{ value: count }` maps from an engine, as the contract's top-20 facet list. */
export const facetList = (counts: Record<string, number> = {}): { value: string; count: number }[] =>
  Object.entries(counts)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 20);

export const tookMs = (started: number): number => Math.round((performance.now() - started) * 10) / 10;
