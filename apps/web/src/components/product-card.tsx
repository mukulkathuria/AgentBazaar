import type { Language } from '@agentbazaar/contracts';
import Link from 'next/link';
import type { CardProduct } from '@/lib/catalog';
import type { Dict } from '@/lib/i18n/en';
import { Price } from './price';
import { ProductImage } from './product-image';

export function ProductCard({ p, lang, t }: { p: CardProduct; lang: Language; t: Dict['product'] }) {
  return (
    <article className="flex h-full flex-col gap-2 rounded-lg border border-gray-300 bg-white p-3">
      <Link href={`/p/${p.slug}`} className="group flex flex-1 flex-col gap-2 no-underline">
        <ProductImage src={p.image} name={p.name} decorative />
        <span className="text-xs uppercase tracking-wide text-gray-700">{p.brand}</span>
        <h3 className="font-semibold text-gray-900 group-hover:underline">{p.name}</h3>
      </Link>
      <Price pricePaise={p.minPricePaise} maxPricePaise={p.maxPricePaise} lang={lang} t={t} />
      <p className={`text-sm ${p.inStock ? 'text-green-800' : 'text-red-700'}`}>{p.inStock ? t.inStock : t.outOfStock}</p>
      {p.customizable && <p className="text-sm text-gray-700">{t.personalisable}</p>}
    </article>
  );
}

export function ProductGrid({ products, lang, t }: { products: CardProduct[]; lang: Language; t: Dict['product'] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <li key={p.slug}>
          <ProductCard p={p} lang={lang} t={t} />
        </li>
      ))}
    </ul>
  );
}
