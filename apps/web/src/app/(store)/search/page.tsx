import type { Metadata } from 'next';
import { ProductListing } from '@/components/product-listing';
import { ErrorState } from '@/components/ui';
import { parseListingParams, searchProducts, type SearchParams } from '@/lib/catalog';
import { fmt } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';

type Props = { searchParams: Promise<SearchParams> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { t } = await getI18n();
  const { q } = parseListingParams(await searchParams);
  return { title: q ? fmt(t.listing.resultsFor, { q }) : t.listing.searchTitle, robots: { index: false } };
}

export default async function SearchPage({ searchParams }: Props) {
  const { lang, t } = await getI18n();
  const params = parseListingParams(await searchParams);
  const hasQuery = Boolean(params.q || params.brand || params.category);
  const result = hasQuery ? await searchProducts(params) : null;

  return (
    <>
      <h1 className="mb-4 text-3xl font-bold">{params.q ? fmt(t.listing.resultsFor, { q: params.q }) : t.listing.searchTitle}</h1>
      {!result && <p>{t.listing.searchPrompt}</p>}
      {result && !result.ok && <ErrorState title={t.errors.title} message={t.errors.unavailable} />}
      {result?.ok && <ProductListing result={result.data} params={params} basePath="/search" categoryFilter lang={lang} t={t} />}
    </>
  );
}
