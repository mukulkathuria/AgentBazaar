'use client';

import { Routes, ShipOrderInput, Uuid, type OrderView } from '@agentbazaar/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Field, inputClass } from '@/components/ui';
import { api, messageOf } from '@/lib/client-api';
import { fmt } from '@/lib/format';
import { apiPath } from '@/lib/http';
import { useI18n } from '@/lib/i18n/context';

const ACTIONS = {
  ship: Routes.adminShipOrder.path,
  deliver: Routes.adminDeliverOrder.path,
  completeReturn: Routes.adminCompleteReturn.path,
} as const;
type Action = keyof typeof ACTIONS;

/** Ship / deliver / complete-return by order id (validated locally with the contracts schemas). */
export function AdminOrderActions() {
  const { t } = useI18n();
  const to = t.admin.orders;
  const [orderId, setOrderId] = useState('');
  const [action, setAction] = useState<Action>('ship');
  const [tracking, setTracking] = useState('');
  const [invalid, setInvalid] = useState<{ id?: string; tracking?: string }>({});
  const run = useMutation({
    mutationFn: () =>
      api<OrderView>(apiPath(ACTIONS[action], { id: orderId.trim() }), {
        method: 'POST',
        ...(action === 'ship' ? { json: { trackingNumber: tracking.trim() } } : {}),
      }),
  });

  const submit = () => {
    const idOk = Uuid.safeParse(orderId.trim()).success;
    const trackOk = action !== 'ship' || ShipOrderInput.safeParse({ trackingNumber: tracking }).success;
    setInvalid({ id: idOk ? undefined : t.form.invalid, tracking: trackOk ? undefined : t.form.invalid });
    if (idOk && trackOk) run.mutate();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
      className="max-w-xl space-y-3 rounded-lg border border-gray-300 p-4"
    >
      <p>{to.intro}</p>
      <Field id="order-id" label={to.orderId} error={invalid.id}>
        {(a) => <input {...a} value={orderId} onChange={(e) => setOrderId(e.target.value)} autoComplete="off" className={`${inputClass} font-mono`} />}
      </Field>
      <Field id="order-action" label={to.action}>
        {(a) => (
          <select {...a} value={action} onChange={(e) => setAction(e.target.value as Action)} className={inputClass}>
            {(Object.keys(ACTIONS) as Action[]).map((key) => (
              <option key={key} value={key}>
                {to[key]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {action === 'ship' && (
        <Field id="order-tracking" label={to.tracking} error={invalid.tracking}>
          {(a) => <input {...a} value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={40} className={inputClass} />}
        </Field>
      )}
      <Button type="submit" disabled={run.isPending}>
        {to.run}
      </Button>
      <p role="status">{run.data ? fmt(to.result, { number: run.data.number, status: t.order.statuses[run.data.status] }) : ''}</p>
      {run.isError && (
        <p role="alert" className="font-medium text-red-700">
          {messageOf(run.error, t.errors.unavailable)}
        </p>
      )}
    </form>
  );
}
