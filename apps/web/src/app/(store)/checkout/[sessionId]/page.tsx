import { formatInr, Routes, Uuid, type CheckoutSessionView } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckoutForm } from '@/components/checkout/checkout-form';
import { Alert, Badge, ErrorState } from '@/components/ui';
import { firstParam, type SearchParams } from '@/lib/catalog';
import { fmt, formatDateTime } from '@/lib/format';
import { apiPath } from '@/lib/http';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ sessionId: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t.checkout.title, robots: { index: false } };
}

export default async function CheckoutPage({ params, searchParams }: Props) {
  const { lang, t } = await getI18n();
  const { sessionId } = await params;
  const token = firstParam((await searchParams).t);
  const back = <Link href="/cart">{t.checkout.backToCart}</Link>;
  if (!token || !Uuid.safeParse(sessionId).success) {
    return <ErrorState title={t.checkout.title} message={t.checkout.missingToken}>{back}</ErrorState>;
  }
  const res = await callApi<CheckoutSessionView>(apiPath(Routes.getCheckout.path, { id: sessionId }, { t: token }));
  if (!res.ok) {
    const message = res.status >= 500 ? t.errors.unavailable : t.checkout.invalid;
    return <ErrorState title={t.checkout.title} message={message}>{back}</ErrorState>;
  }
  const session = res.data;
  if (session.status !== 'open') {
    return <ErrorState title={t.checkout.title} message={t.checkout[session.status]}>{back}</ErrorState>;
  }

  return (
    <>
      <h1 className="mb-6 text-3xl font-bold">{t.checkout.title}</h1>
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <CheckoutForm sessionId={session.sessionId} token={token} terms={session.terms} />
        <aside aria-labelledby="checkout-summary" className="h-fit space-y-3 rounded-lg border border-gray-300 p-4 lg:order-last">
          <h2 id="checkout-summary" className="text-lg font-semibold">
            {t.checkout.summary}
          </h2>
          <ul className="space-y-2 text-sm">
            {session.lines.map((line) => (
              <li key={line.sku} className="flex justify-between gap-2">
                <span>
                  {line.quantity} × {line.productName} {line.nonReturnable && <Badge tone="warning">{t.cart.nonReturnable}</Badge>}
                </span>
                <span className="font-medium">{formatInr(line.totalPaise, lang)}</span>
              </li>
            ))}
          </ul>
          <p className="flex justify-between border-t border-gray-300 pt-2 font-semibold">
            <span>{t.cart.subtotal}</span>
            <span>{formatInr(session.subtotalPaise, lang)}</span>
          </p>
          {session.source === 'quote' && <p className="text-sm text-green-800">{t.checkout.negotiated}</p>}
          <p className="text-sm text-gray-700">{fmt(t.checkout.heldUntil, { time: formatDateTime(session.expiresAt, lang) })}</p>
          {session.lines.some((l) => l.nonReturnable) && <Alert tone="warning">{t.checkout.nonReturnable}</Alert>}
        </aside>
      </div>
    </>
  );
}
