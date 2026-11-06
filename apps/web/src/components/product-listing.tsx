import type { Language, SearchResult } from '@agentbazaar/contracts';
import Link from 'next/link';
import { listingHref, PAGE_SIZE, type ListingParams } from '@/lib/catalog';
import { fmt } from '@/lib/format';
import type { Dict } from '@/lib/i18n/en';
import { ProductGrid } from './product-card';
import { buttonClass, Field, inputClass } from './ui';

interface ListingProps {
  result: SearchResult;
  params: ListingParams;
  basePath: string;
  /** Search page: category is a filter. Category page: it is fixed by the URL. */
  categoryFilter: boolean;
  lang: Language;
  t: Dict;
}

function Facets({ result, params, basePath, categoryFilter, t }: Omit<ListingProps, 'lang'>) {
  return (
    <form action={basePath} method="get" aria-labelledby="filters-heading" className="space-y-4 rounded-lg border border-gray-300 p-4">
      <h2 id="filters-heading" className="text-lg font-semibold">
        {t.listing.filters}
      </h2>
      {params.q && <input type="hidden" name="q" value={params.q} />}
      <Field id="f-brand" label={t.listing.brand}>
        {(a) => (
          <select {...a} name="brand" defaultValue={params.brand ?? ''} className={inputClass}>
            <option value="">{t.listing.anyBrand}</option>
            {result.facets.brands.map((b) => (
              <option key={b.value} value={b.value}>
                {b.value} ({b.count})
              </option>
            ))}
          </select>
        )}
      </Field>
      {categoryFilter && (
        <Field id="f-category" label={t.listing.category}>
          {(a) => (
            <select {...a} name="category" defaultValue={params.category ?? ''} className={inputClass}>
              <option value="">{t.listing.anyCategory}</option>
              {result.facets.categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.value} ({c.count})
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field id="f-min" label={t.listing.minPrice}>
          {(a) => <input {...a} name="min" inputMode="decimal" defaultValue={params.min} className={inputClass} />}
        </Field>
        <Field id="f-max" label={t.listing.maxPrice}>
          {(a) => <input {...a} name="max" inputMode="decimal" defaultValue={params.max} className={inputClass} />}
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <input id="f-stock" type="checkbox" name="inStock" value="1" defaultChecked={params.inStock} className="size-5" />
        <label htmlFor="f-stock">{t.listing.inStock}</label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass()}>
          {t.listing.apply}
        </button>
        <Link href={params.q ? `${basePath}?q=${encodeURIComponent(params.q)}` : basePath}>{t.listing.clear}</Link>
      </div>
    </form>
  );
}

function Pagination({ page, pages, href, t }: { page: number; pages: number; href: (p: number) => string; t: Dict['common'] }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={t.pagination} className="mt-6 flex items-center justify-between gap-4">
      {page > 1 ? (
        <Link href={href(page - 1)} rel="prev">
          {t.previous}
        </Link>
      ) : (
        <span />
      )}
      <span>{fmt(t.pageOf, { page, pages })}</span>
      {page < pages ? (
        <Link href={href(page + 1)} rel="next">
          {t.next}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** Results grid with GET-form facets (works without JavaScript) and pagination. */
export function ProductListing(props: ListingProps) {
  const { result, params, basePath, categoryFilter, lang, t } = props;
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <Facets {...props} />
      <section aria-labelledby="results-heading">
        <h2 id="results-heading" className="mb-3 text-lg font-semibold">
          {fmt(t.listing.results, { n: result.total })}
        </h2>
        {result.items.length ? <ProductGrid products={result.items} lang={lang} t={t.product} /> : <p>{t.listing.noResults}</p>}
        <Pagination page={params.page} pages={pages} href={(p) => listingHref(basePath, params, p, categoryFilter)} t={t.common} />
      </section>
    </div>
  );
}
