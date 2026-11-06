import { Routes, type PublicProduct } from '@agentbazaar/contracts';
import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { categoryHref, getCategories } from '@/lib/catalog';
import { SITE_URL } from '@/lib/env';
import { LEGAL_DOCS } from '@/lib/legal';
import { callApi } from '@/lib/server-api';

const FEED_PAGE = 100;
// shortcut: one sitemap of up to 10,000 products (the feed's offset cap); switch to generateSitemaps() beyond that.
const MAX_OFFSET = 10_000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection(); // request time only: never fetch the API during `next build`
  const entries: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, changeFrequency: 'daily', priority: 1 },
    ...LEGAL_DOCS.map((doc) => ({ url: `${SITE_URL}/legal/${doc}`, changeFrequency: 'yearly' as const, priority: 0.2 })),
  ];
  const categories = await getCategories();
  if (categories.ok) {
    for (const c of categories.data) entries.push({ url: `${SITE_URL}${categoryHref(c.path)}`, changeFrequency: 'daily', priority: 0.7 });
  }
  for (let offset = 0; offset <= MAX_OFFSET; offset += FEED_PAGE) {
    const page = await callApi<PublicProduct[]>(Routes.productFeed.path, {
      query: { limit: FEED_PAGE, offset },
      cache: { revalidate: 900, tags: ['feed'] },
    });
    if (!page.ok) break;
    for (const p of page.data) {
      entries.push({ url: `${SITE_URL}/p/${p.slug}`, lastModified: p.updatedAt, changeFrequency: 'daily', priority: 0.8 });
    }
    if (page.data.length < FEED_PAGE) break;
  }
  return entries;
}
