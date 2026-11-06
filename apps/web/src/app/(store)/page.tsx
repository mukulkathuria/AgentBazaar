import Link from 'next/link';
import { ProductGrid } from '@/components/product-card';
import { ErrorState, Section } from '@/components/ui';
import { cardFromProduct, categoryHref, getCategories, getProduct } from '@/lib/catalog';
import { fmt } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';

const HERO_SLUGS = [
  'thock-tk87-mechanical-keyboard',
  'zentrix-zx7070-12gb',
  'mitti-personalised-ceramic-mug',
  'kokoa-mini-milk-chocolate-13g',
];

// Request-time render (lang cookie); catalogue fetches use the data cache, so no force-dynamic here.
export default async function HomePage() {
  const { lang, t } = await getI18n();
  const [categories, ...heroes] = await Promise.all([getCategories(), ...HERO_SLUGS.map((slug) => getProduct(slug))]);
  const featured = heroes.flatMap((r) => (r.ok ? [cardFromProduct(r.data)] : []));
  const nodes = categories.ok ? categories.data : [];
  const topDepth = Math.min(...nodes.map((c) => c.depth));
  const top = nodes.filter((c) => c.depth === topDepth);

  return (
    <>
      <section className="rounded-xl bg-blue-50 p-6 md:p-10">
        <h1 className="text-3xl font-bold text-gray-900 md:text-4xl">{t.home.heroTitle}</h1>
        <p className="mt-3 max-w-2xl text-lg text-gray-800">{t.home.heroBody}</p>
      </section>
      {!categories.ok && featured.length === 0 && <ErrorState title={t.errors.title} message={t.errors.unavailable} />}
      {top.length > 0 && (
        <Section id="home-categories" title={t.home.categories}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {top.map((c) => (
              <li key={c.path}>
                <Link href={categoryHref(c.path)} className="block rounded-lg border border-gray-300 p-4 no-underline hover:bg-gray-50">
                  <span className="block font-semibold text-gray-900">{c.name}</span>
                  <span className="block text-sm text-gray-700">{fmt(t.home.productCount, { n: c.productCount })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {featured.length > 0 && (
        <Section id="home-featured" title={t.home.featured}>
          <ProductGrid products={featured} lang={lang} t={t.product} />
        </Section>
      )}
    </>
  );
}
