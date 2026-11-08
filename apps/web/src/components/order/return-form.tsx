'use client';

import { ReturnRequestInput, Routes } from '@agentbazaar/contracts';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, inputClass } from '@/components/ui';
import { api, messageOf } from '@/lib/client-api';
import { apiPath } from '@/lib/http';
import { useI18n } from '@/lib/i18n/context';

const REASONS = ReturnRequestInput.shape.reason.options;

export function ReturnForm({ orderId, token }: { orderId: string; token?: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [reason, setReason] = useState<(typeof REASONS)[number]>('damaged');
  const [note, setNote] = useState('');
  const request = useMutation({
    mutationFn: () =>
      api<unknown>(apiPath(Routes.requestReturn.path, { id: orderId }, { t: token }), {
        method: 'POST',
        json: { reason, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    onSuccess: () => router.refresh(),
  });
  return (
    <form
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        request.mutate();
      }}
      aria-labelledby="return-heading"
      className="space-y-3 rounded-lg border border-gray-300 p-4"
    >
      <h2 id="return-heading" className="text-lg font-semibold">
        {t.order.returnTitle}
      </h2>
      <Field id="return-reason" label={t.order.reason}>
        {(a) => (
          <select {...a} value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className={inputClass}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {t.order.reasons[r]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="return-note" label={t.order.note}>
        {(a) => <textarea {...a} value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} className={inputClass} />}
      </Field>
      <Button type="submit" disabled={request.isPending}>
        {t.order.requestReturn}
      </Button>
      {request.isSuccess && <p role="status">{t.order.returnRequested}</p>}
      {request.isError && (
        <p role="alert" className="font-medium text-red-700">
          {messageOf(request.error, t.errors.unavailable)}
        </p>
      )}
    </form>
  );
}
