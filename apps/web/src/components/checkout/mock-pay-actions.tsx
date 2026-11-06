'use client';

import type { PaymentView } from '@agentbazaar/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { PATHS } from '@/lib/api-paths';
import { api, messageOf } from '@/lib/client-api';
import { fmt } from '@/lib/format';
import { apiPath } from '@/lib/http';
import { useI18n } from '@/lib/i18n/context';
import { orderTokenKey } from '@/lib/urls';

const MAX_POLLS = 30;

function orderHref(orderId: string): string {
  const token = sessionStorage.getItem(orderTokenKey(orderId));
  return `/orders/${orderId}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
}

/** "Pay" / "Simulate failure" against the mock gateway, then polls the payment until it leaves `created`. */
export function MockPayActions({
  paymentId,
  token,
  orderId,
  amountLabel,
}: {
  paymentId: string;
  token: string;
  orderId: string;
  amountLabel: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const complete = useMutation({
    mutationFn: (outcome: 'success' | 'failure') =>
      api<unknown>(apiPath(PATHS.mockGatewayComplete, { id: paymentId }), { method: 'POST', json: { outcome } }),
  });
  const [polls, setPolls] = useState(0);
  const payment = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => {
      setPolls((n) => n + 1);
      return api<PaymentView>(apiPath(PATHS.getPayment, { id: paymentId }, { t: token }));
    },
    enabled: complete.isSuccess,
    refetchInterval: (q) => ((q.state.data?.status ?? 'created') === 'created' && polls < MAX_POLLS ? 1000 : false),
  });
  const status = payment.data?.status;
  const settled = status !== undefined && status !== 'created';

  useEffect(() => {
    if (settled) router.replace(orderHref(orderId));
  }, [settled, orderId, router]);

  const waiting = complete.isSuccess && !settled;
  const slow = waiting && polls >= MAX_POLLS;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Button disabled={complete.isPending || complete.isSuccess} onClick={() => complete.mutate('success')}>
          {fmt(t.pay.pay, { amount: amountLabel })}
        </Button>
        <Button variant="secondary" disabled={complete.isPending || complete.isSuccess} onClick={() => complete.mutate('failure')}>
          {t.pay.fail}
        </Button>
      </div>
      <p role="status">{complete.isPending ? t.pay.processing : waiting ? t.pay.waiting : ''}</p>
      {complete.isError && (
        <p role="alert" className="font-medium text-red-700">
          {messageOf(complete.error, t.errors.unavailable)}
        </p>
      )}
      {(slow || payment.isError) && (
        <p>
          {t.pay.slow} <Link href={`/orders/${orderId}`}>{t.pay.viewOrder}</Link>
        </p>
      )}
    </div>
  );
}
