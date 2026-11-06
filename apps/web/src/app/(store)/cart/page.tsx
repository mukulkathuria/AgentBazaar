import { formatInr, Routes, Uuid, type CartView, type Language } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { Alert, Badge, buttonClass, ErrorState, inputClass } from '@/components/ui';
import { firstParam, type SearchParams } from '@/lib/catalog';
import { fmt } from '@/lib/format';
import { apiPath } from '@/lib/http';
import type { Dict } from '@/lib/i18n/en';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';
import { COOKIE } from '@/lib/session';
import { removeCartLine, startCheckout, updateCartLine } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t.cart.title, robots: { index: false } };
}

function errorText(code: string, t: Dict): string {
  if (code === 'out_of_stock') return t.cart.outOfStock;
  if (code === 'price_changed') return t.cart.priceChanged;
  if (code === 'unavailable') return t.errors.unavailable;
  return code === 'checkout' ? t.cart.checkoutError : t.cart.error;
}

function CartLine({ line, lang, t }: { line: CartView['lines'][number]; lang: Language; t: Dict }) {
  const qtyId = `qty-${line.lineId}`;
  return (
    <li className="flex flex-col gap-3 border-b border-gray-300 py-4 sm:flex-row sm:items-start">
      <div className="flex-1 space-y-1">
        <p className="font-semibold">{line.productName}</p>
        <p className="text-sm text-gray-700">
          {line.variantTitle} · {fmt(t.cart.each, { price: formatInr(line.unitPricePaise, lang) })}
        </p>
        {line.customization && Object.keys(line.customization.text).length > 0 && (
          <dl className="text-sm">
            <dt className="font-medium">{t.cart.personalisation}</dt>
            {Object.entries(line.customization.text).map(([field, value]) => (
              <dd key={field}>
                {field}: {value}
              </dd>
            ))}
          </dl>
        )}
        {line.nonReturnable && <Badge tone="warning">{t.cart.nonReturnable}</Badge>}
      </div>
      <form action={updateCartLine} className="flex items-center gap-2">
        <input type="hidden" name="lineId" value={line.lineId} />
        <label htmlFor={qtyId} className="sr-only">
          {fmt(t.cart.quantityFor, { name: line.productName })}
        </label>
        <input id={qtyId} name="quantity" type="number" min={1} max={1000} defaultValue={line.quantity} className={`${inputClass} w-20`} />
        <button type="submit" className={buttonClass('secondary')}>
          {t.cart.update}
        </button>
      </form>
      <form action={removeCartLine}>
        <input type="hidden" name="lineId" value={line.lineId} />
        <button type="submit" aria-label={fmt(t.cart.removeItem, { name: line.productName })} className={buttonClass('secondary')}>
          {t.cart.remove}
        </button>
      </form>
      <p className="font-semibold sm:w-28 sm:text-right">{formatInr(line.totalPaise, lang)}</p>
    </li>
  );
}

export default async function CartPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { lang, t } = await getI18n();
  const error = firstParam((await searchParams).error);
  const cartId = (await cookies()).get(COOKIE.cart)?.value;
  const res = cartId && Uuid.safeParse(cartId).success ? await callApi<CartView>(apiPath(Routes.getCart.path, { id: cartId })) : null;
  if (res && !res.ok && res.status !== 404) return <ErrorState title={t.cart.title} message={t.errors.unavailable} />;
  const cart = res?.ok ? res.data : null;

  return (
    <>
      <h1 className="mb-4 text-3xl font-bold">{t.cart.title}</h1>
      {error && <Alert>{errorText(error, t)}</Alert>}
      {!cart?.lines.length ? (
        <div className="space-y-4">
          <p>{t.cart.empty}</p>
          <Link href="/" className={buttonClass()}>
            {t.cart.continue}
          </Link>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <ul>
            {cart.lines.map((line) => (
              <CartLine key={line.lineId} line={line} lang={lang} t={t} />
            ))}
          </ul>
          <aside aria-labelledby="cart-summary" className="h-fit space-y-3 rounded-lg border border-gray-300 p-4">
            <h2 id="cart-summary" className="flex justify-between text-lg font-semibold">
              <span>{t.cart.subtotal}</span>
              <span>{formatInr(cart.subtotalPaise, lang)}</span>
            </h2>
            <p className="text-sm text-gray-700">{t.cart.taxNote}</p>
            <form action={startCheckout}>
              {/* One key per rendered form: a double submit replays the same checkout session. */}
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <button type="submit" className={buttonClass('primary', 'w-full')}>
                {t.cart.checkout}
              </button>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
