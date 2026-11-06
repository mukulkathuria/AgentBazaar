import type { CategoryNode } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ProductListing } from '@/components/product-listing';
import { ErrorState } from '@/components/ui';
import { categoryHref, getCategories, parseListingParams, searchProducts, type SearchParams } from '@/lib/catalog';
import { getI18n } from '@/lib/i18n/server';

type Props = { params: Promise<{ path: string[] }>; searchParams: Promise<SearchParams> };

const LABEL = /^[a-z0-9_]+$/;
const humanize = (label: string) => label.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function nameOf(nodes: CategoryNode[], ltree: string): string {
  return nodes.find((c) => c.path === ltree)?.name ?? humanize(ltree.split('.').at(-1) ?? ltree);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { path } = await params;
  const categories = await getCategories();
  const ltree = path.join('.');
  return { title: nameOf(categories.ok ? categories.data : [], ltree), alternates: { canonical: categoryHref(ltree) } };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { lang, t } = await getI18n();
  const { path } = await params;
  if (!path.length || !path.every((label) => LABEL.test(label))) notFound();
  const ltree = path.join('.');
  const listing = parseListingParams(await searchParams);
  const [categories, result] = await Promise.all([getCategories(), searchProducts({ ...listing, category: ltree })]);
  const nodes = categories.ok ? categories.data : [];
  if (categories.ok && !nodes.some((c) => c.path === ltree)) notFound();

  const crumbs = [
    { name: t.common.home, href: '/' },
    ...path.map((_, i) => {
      const prefix = path.slice(0, i + 1).join('.');
      return { name: nameOf(nodes, prefix), href: i < path.length - 1 ? categoryHref(prefix) : undefined };
    }),
  ];
  const children = nodes.filter((c) => c.path.startsWith(`${ltree}.`) && c.path.split('.').length === path.length + 1);

  return (
    <>
      <Breadcrumbs items={crumbs} label={t.common.breadcrumb} />
      <h1 className="mb-4 text-3xl font-bold">{nameOf(nodes, ltree)}</h1>
      {children.length > 0 && (
        <nav aria-label={t.listing.subcategories} className="mb-6">
          <ul className="flex flex-wrap gap-2">
            {children.map((c) => (
              <li key={c.path}>
                <Link href={categoryHref(c.path)} className="inline-block rounded-full border border-gray-400 px-3 py-1">
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {result.ok ? (
        <ProductListing result={result.data} params={listing} basePath={categoryHref(ltree)} categoryFilter={false} lang={lang} t={t} />
      ) : (
        <ErrorState title={t.errors.title} message={t.errors.unavailable} />
      )}
    </>
  );
}
