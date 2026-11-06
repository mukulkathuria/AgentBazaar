import {
  rupeesToPaise,
  Routes,
  type CategoryNode,
  type CustomizationOptions,
  type ProductSummary,
  type PublicProduct,
  type SearchResult,
} from '@agentbazaar/contracts';
import { apiPath } from './http';
import { callApi } from './server-api';

export const PAGE_SIZE = 12;
const MAX_PAGE = 400; // API caps offset at 5000

export const productTag = (slug: string) => `product:${slug}`;
export const categoryHref = (ltreePath: string) => `/c/${ltreePath.split('.').join('/')}`;

export function getCategories() {
  return callApi<CategoryNode[]>(Routes.listCategories.path, { cache: { revalidate: 600, tags: ['categories'] } });
}

export function getProduct(slug: string) {
  return callApi<PublicProduct>(apiPath(Routes.getProduct.path, { slug }), {
    cache: { revalidate: 300, tags: [productTag(slug)] },
  });
}

export function getRelated(slug: string, kind: 'recommendations' | 'compatibleItems') {
  return callApi<ProductSummary[]>(apiPath(Routes[kind].path, { slug }), {
    cache: { revalidate: 300, tags: [productTag(slug)] },
  });
}

export function getCustomizationOptions(sku: string) {
  return callApi<CustomizationOptions>(apiPath(Routes.customizationOptions.path, { sku }), { cache: { revalidate: 300 } });
}

export type CardProduct = Pick<
  ProductSummary,
  'slug' | 'name' | 'brand' | 'minPricePaise' | 'maxPricePaise' | 'inStock' | 'image' | 'customizable'
>;

export function cardFromProduct(p: PublicProduct): CardProduct {
  const prices = p.variants.map((v) => v.pricePaise);
  return {
    slug: p.slug,
    name: p.name,
    brand: p.brand,
    minPricePaise: Math.min(...prices),
    maxPricePaise: Math.max(...prices),
    inStock: p.variants.some((v) => v.inStock),
    image: p.images[0] ?? null,
    customizable: p.customizable,
  };
}

// ---- listing (category + search) query string <-> API query ----

export type SearchParams = Record<string, string | string[] | undefined>;

export interface ListingParams {
  q: string;
  brand?: string;
  category?: string;
  min?: string;
  max?: string;
  inStock: boolean;
  page: number;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

export function parseListingParams(sp: SearchParams): ListingParams {
  const page = Number(one(sp.page) ?? '1');
  return {
    q: (one(sp.q) ?? '').slice(0, 200),
    brand: one(sp.brand)?.slice(0, 80),
    category: one(sp.category)?.slice(0, 200),
    min: one(sp.min),
    max: one(sp.max),
    inStock: one(sp.inStock) === '1',
    page: Number.isInteger(page) && page > 0 ? Math.min(page, MAX_PAGE) : 1,
  };
}

function paise(rupees: string | undefined): number | undefined {
  if (!rupees) return undefined;
  try {
    return rupeesToPaise(rupees);
  } catch {
    return undefined;
  }
}

export function searchProducts(p: ListingParams) {
  return callApi<SearchResult>(Routes.searchProducts.path, {
    query: {
      q: p.q,
      category: p.category,
      brand: p.brand,
      minPricePaise: paise(p.min),
      maxPricePaise: paise(p.max),
      inStockOnly: p.inStock || undefined,
      limit: PAGE_SIZE,
      offset: (p.page - 1) * PAGE_SIZE,
    },
  });
}

/** Link to another page of the same listing, keeping the active filters. */
export function listingHref(basePath: string, p: ListingParams, page: number, keepCategory: boolean): string {
  const qs = new URLSearchParams();
  const set = (k: string, v: string | undefined) => v && qs.set(k, v);
  set('q', p.q);
  set('brand', p.brand);
  if (keepCategory) set('category', p.category);
  set('min', p.min);
  set('max', p.max);
  if (p.inStock) qs.set('inStock', '1');
  if (page > 1) qs.set('page', String(page));
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}

export const firstParam = one;
