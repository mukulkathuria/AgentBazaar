import { formatInr, Routes, type OrderView } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SessionRefresher } from '@/components/session-refresher';
import { Badge, ErrorState } from '@/components/ui';
import { fmt, formatDateTime } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t.account.orders, robots: { index: false } };
}

export default async function MyOrdersPage() {
  const { lang, t } = await getI18n();
  const session = await getSession();
  if (session.canRefresh) return <SessionRefresher />;
  const res = session.accessToken ? await callApi<OrderView[]>(Routes.myOrders.path, { query: { limit: 50 } }) : null;
  if (!res || (!res.ok && res.status === 401)) {
    return (
      <ErrorState title={t.account.orders} message={t.account.signInForOrders}>
        <Link href="/account?next=/account/orders">{t.account.signIn}</Link>
      </ErrorState>
    );
  }
  if (!res.ok) return <ErrorState title={t.account.orders} message={t.errors.unavailable} />;

  return (
    <>
      <h1 className="mb-4 text-3xl font-bold">{t.account.orders}</h1>
      {res.data.length === 0 ? (
        <p>{t.account.noOrders}</p>
      ) : (
        <ul className="divide-y divide-gray-300 rounded-lg border border-gray-300">
          {res.data.map((o) => (
            <li key={o.orderId} className="flex flex-wrap items-center justify-between gap-2 p-4">
              <div>
                <Link href={`/orders/${o.orderId}`} className="font-semibold">
                  {fmt(t.order.title, { number: o.number })}
                </Link>
                <p className="text-sm text-gray-700">{formatDateTime(o.createdAt, lang)}</p>
              </div>
              <Badge>{t.order.statuses[o.status]}</Badge>
              <span className="font-semibold">{formatInr(o.totalPaise, lang)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
