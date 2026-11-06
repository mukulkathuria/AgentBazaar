import { formatInr, Routes, Uuid, type Language, type OrderStatus, type OrderView } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionButton } from '@/components/action-button';
import { ReturnForm } from '@/components/order/return-form';
import { Badge, buttonClass, ErrorState } from '@/components/ui';
import { firstParam, type SearchParams } from '@/lib/catalog';
import { fmt, formatDateTime } from '@/lib/format';
import { apiPath } from '@/lib/http';
import type { Dict } from '@/lib/i18n/en';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';
import { toLocalHref } from '@/lib/urls';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> };

const CANCELLABLE: OrderStatus[] = ['pending_payment', 'payment_observed', 'paid', 'cod_confirmed'];

export async function generateMetadata(): Promise<Metadata> {
  return { robots: { index: false } };
}

function Lines({ order, lang, t }: { order: OrderView; lang: Language; t: Dict }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{t.order.items}</caption>
      <thead>
        <tr className="border-b border-gray-300">
          <th scope="col" className="py-2">{t.order.product}</th>
          <th scope="col" className="py-2">{t.order.qty}</th>
          <th scope="col" className="py-2">{t.order.tax}</th>
          <th scope="col" className="py-2 text-right">{t.order.total}</th>
        </tr>
      </thead>
      <tbody>
        {order.lines.map((line) => (
          <tr key={line.sku} className="border-b border-gray-200 align-top">
            <td className="py-2">
              {line.productName}
              {line.nonReturnable && (
                <>
                  {' '}
                  <Badge tone="warning">{t.order.nonReturnable}</Badge>
                </>
              )}
              {line.customization &&
                Object.entries(line.customization.text).map(([field, value]) => (
                  <span key={field} className="block text-gray-700">
                    {field}: {value}
                  </span>
                ))}
            </td>
            <td className="py-2">{line.quantity}</td>
            <td className="py-2">
              {line.taxes.map((tax) => (
                <span key={tax.kind} className="block">
                  {tax.kind} {tax.rateBps / 100}%: {formatInr(tax.amountPaise, lang)}
                </span>
              ))}
            </td>
            <td className="py-2 text-right">{formatInr(line.totalPaise, lang)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Summary({ order, lang, t }: { order: OrderView; lang: Language; t: Dict }) {
  const rows: [string, string | null][] = [
    [t.order.subtotal, formatInr(order.subtotalPaise, lang)],
    [t.order.tax, formatInr(order.taxPaise, lang)],
    [t.order.total, formatInr(order.totalPaise, lang)],
    [t.order.paymentMethod, t.order.methods[order.paymentMethod]],
    [t.order.invoice, order.invoiceNumber],
    [t.order.tracking, order.trackingNumber],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-gray-300 p-4 text-sm">
      {rows
        .filter((row): row is [string, string] => row[1] !== null)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium">{label}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export default async function OrderPage({ params, searchParams }: Props) {
  const { lang, t } = await getI18n();
  const { id } = await params;
  const token = firstParam((await searchParams).t);
  const res = Uuid.safeParse(id).success ? await callApi<OrderView>(apiPath(Routes.getOrder.path, { id }, { t: token })) : null;
  if (!res?.ok) {
    const message = res && !res.ok && res.status >= 500 ? t.errors.unavailable : t.order.notFound;
    return <ErrorState title={t.order.items} message={message} />;
  }
  const order = res.data;
  const payHref = order.status === 'pending_payment' && order.paymentUrl ? toLocalHref(order.paymentUrl) : null;
  const canReturn = order.status === 'delivered' && order.lines.some((l) => !l.nonReturnable);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold">{fmt(t.order.title, { number: order.number })}</h1>
        <p className="text-gray-700">{fmt(t.order.placed, { date: formatDateTime(order.createdAt, lang) })}</p>
        <p>
          {t.order.status}: <Badge>{t.order.statuses[order.status]}</Badge>
        </p>
      </div>
      {payHref && (
        <a href={payHref} className={buttonClass()}>
          {t.order.completePayment}
        </a>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section aria-labelledby="order-items" className="space-y-3">
          <h2 id="order-items" className="text-xl font-semibold">
            {t.order.items}
          </h2>
          <Lines order={order} lang={lang} t={t} />
        </section>
        <Summary order={order} lang={lang} t={t} />
      </div>
      <section aria-labelledby="order-timeline" className="space-y-3">
        <h2 id="order-timeline" className="text-xl font-semibold">
          {t.order.timeline}
        </h2>
        <ol className="space-y-2 border-l-2 border-blue-700 pl-4">
          {order.timeline.map((event) => (
            <li key={`${event.status}-${event.at}`}>
              <p className="font-medium">{t.order.statuses[event.status]}</p>
              <p className="text-sm text-gray-700">{formatDateTime(event.at, lang)}</p>
              {event.note && <p className="text-sm">{event.note}</p>}
            </li>
          ))}
        </ol>
      </section>
      {CANCELLABLE.includes(order.status) && (
        <ActionButton path={apiPath(Routes.cancelOrder.path, { id: order.orderId }, { t: token })} label={t.order.cancel} variant="danger" />
      )}
      {canReturn && <ReturnForm orderId={order.orderId} token={token} />}
      <p>
        <Link href="/account/orders">{t.account.orders}</Link>
      </p>
    </div>
  );
}
