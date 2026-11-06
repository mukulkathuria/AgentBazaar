import { formatInr, Routes, Uuid, type PaymentView } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { MockPayActions } from '@/components/checkout/mock-pay-actions';
import { Alert, ErrorState } from '@/components/ui';
import { firstParam, type SearchParams } from '@/lib/catalog';
import { apiPath } from '@/lib/http';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ paymentId: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t.pay.title, robots: { index: false } };
}

export default async function MockPaymentPage({ params, searchParams }: Props) {
  const { lang, t } = await getI18n();
  const { paymentId } = await params;
  const token = firstParam((await searchParams).t);
  const res =
    token && Uuid.safeParse(paymentId).success
      ? await callApi<PaymentView>(apiPath(Routes.getPayment.path, { id: paymentId }, { t: token }))
      : null;
  if (!res?.ok || !token) {
    const message = res && !res.ok && res.status >= 500 ? t.errors.unavailable : t.pay.invalid;
    return <ErrorState title={t.pay.title} message={message} />;
  }
  const payment = res.data;
  const amount = formatInr(payment.amountPaise, lang);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-3xl font-bold">{t.pay.title}</h1>
      <Alert tone="warning" title={t.pay.banner} />
      <dl className="grid grid-cols-2 gap-2 rounded-lg border border-gray-300 p-4">
        <dt className="font-medium">{t.pay.amount}</dt>
        <dd className="text-xl font-bold">{amount}</dd>
        <dt className="font-medium">{t.pay.order}</dt>
        <dd className="break-all font-mono text-sm">{payment.orderId}</dd>
      </dl>
      {payment.provider !== 'mock' && <Alert tone="info">{t.pay.notMock}</Alert>}
      {payment.provider === 'mock' && payment.status === 'created' && (
        <MockPayActions paymentId={payment.paymentId} token={token} orderId={payment.orderId} amountLabel={amount} />
      )}
      {payment.status !== 'created' && (
        <p>
          {t.pay.done} <Link href={`/orders/${payment.orderId}`}>{t.pay.viewOrder}</Link>
        </p>
      )}
    </div>
  );
}
