import { Slug, type ProductSummary, type PublicProduct } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ProductGrid } from '@/components/product-card';
import { ProductImage } from '@/components/product-image';
import { ProductPurchase } from '@/components/product/product-purchase';
import { ErrorState, Section } from '@/components/ui';
import {
  categoryHref,
  firstParam,
  getCustomizationOptions,
  getProduct,
  getRelated,
  type SearchParams,
} from '@/lib/catalog';
import { SITE_URL } from '@/lib/env';
import { fmt } from '@/lib/format';
import type { Dict } from '@/lib/i18n/en';
import { getI18n } from '@/lib/i18n/server';
import type { ApiResult } from '@/lib/server-api';
import { productJsonLd, serializeJsonLd } from '@/lib/seo/jsonld';
import { apiAssetUrl } from '@/lib/urls';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

const humanize = (key: string) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const res = Slug.safeParse(slug).success ? await getProduct(slug) : null;
  if (!res?.ok) return { title: 'Product' };
  const p = res.data;
  const description = p.description.slice(0, 160);
  return {
    title: `${p.name} — ${p.brand}`,
    description,
    alternates: { canonical: `/p/${p.slug}` },
    openGraph: { title: p.name, description, url: `/p/${p.slug}`, images: p.images.slice(0, 1).map(apiAssetUrl) },
  };
}

function Specs({ attributes, t }: { attributes: PublicProduct['attributes']; t: Dict }) {
  const entries = Object.entries(attributes);
  if (!entries.length) return null;
  return (
    <Section id="specs" title={t.product.specs}>
      <table className="w-full max-w-2xl text-left text-sm">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-b border-gray-200">
              <th scope="row" className="w-1/2 py-2 pr-4 font-medium">
                {humanize(key)}
              </th>
              <td className="py-2">{typeof value === 'boolean' ? (value ? t.common.yes : t.common.no) : String(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Faqs({ faqs, t }: { faqs: PublicProduct['faqs']; t: Dict }) {
  if (!faqs.length) return null;
  return (
    <Section id="faqs" title={t.product.faqs}>
      <div className="max-w-3xl divide-y divide-gray-200 rounded-lg border border-gray-300">
        {faqs.map((f) => (
          <details key={f.q} className="p-3">
            <summary className="cursor-pointer font-medium">{f.q}</summary>
            <p className="mt-2 text-gray-800">{f.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function Related({ id, title, res, page }: { id: string; title: string; res: ApiResult<ProductSummary[]>; page: { lang: 'en' | 'hi'; t: Dict } }) {
  if (!res.ok || !res.data.length) return null;
  return (
    <Section id={id} title={title}>
      <ProductGrid products={res.data} lang={page.lang} t={page.t.product} />
    </Section>
  );
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { lang, t } = await getI18n();
  const { slug } = await params;
  if (!Slug.safeParse(slug).success) notFound();
  const res = await getProduct(slug);
  if (!res.ok) {
    if (res.status === 404) notFound();
    return <ErrorState title={t.errors.title} message={t.errors.unavailable} />;
  }
  const p = res.data;
  const defaultSku = p.variants[0]?.sku;
  const [recommendations, compatible, customization] = await Promise.all([
    getRelated(slug, 'recommendations'),
    getRelated(slug, 'compatibleItems'),
    p.customizable && defaultSku ? getCustomizationOptions(defaultSku) : null,
  ]);
  const crumbs = [
    { name: t.common.home, href: '/' },
    ...p.breadcrumbs.map((c) => ({ name: c.name, href: categoryHref(c.path) })),
    { name: p.name },
  ];

  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(productJsonLd(p, SITE_URL)) }} />
      <Breadcrumbs items={crumbs} label={t.common.breadcrumb} />
      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-2">
          <ProductImage src={p.images[0]} name={p.name} />
          {p.images.length > 1 && (
            <ul className="grid grid-cols-4 gap-2">
              {p.images.slice(1).map((src) => (
                <li key={src}>
                  <ProductImage src={src} name={p.name} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-3">
          <p className="text-sm uppercase tracking-wide text-gray-700">{p.brand}</p>
          <h1 className="text-3xl font-bold">{p.name}</h1>
          {p.rating && p.rating.count > 0 && (
            <p>
              <span aria-hidden="true">★ </span>
              {fmt(t.product.rating, { avg: p.rating.average.toFixed(1), n: p.rating.count })}
            </p>
          )}
          <ProductPurchase
            product={{ variants: p.variants, returnable: p.returnable, returnWindowDays: p.returnWindowDays }}
            initialSku={firstParam((await searchParams).sku)}
            customization={
              customization?.ok
                ? // Resolved here (runtime API origin) so server and browser render the same image URLs.
                  { ...customization.data, designs: customization.data.designs.map((d) => ({ ...d, previewUrl: apiAssetUrl(d.previewUrl) })) }
                : null
            }
          />
        </div>
      </div>
      <Section id="description" title={t.product.description}>
        <p className="max-w-3xl whitespace-pre-line text-gray-800">{p.description}</p>
      </Section>
      <Specs attributes={p.attributes} t={t} />
      <Faqs faqs={p.faqs} t={t} />
      <Related id="recommended" title={t.product.recommended} res={recommendations} page={{ lang, t }} />
      <Related id="compatible" title={t.product.compatible} res={compatible} page={{ lang, t }} />
    </article>
  );
}
