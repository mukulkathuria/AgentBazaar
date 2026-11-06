'use client';

import { ConsentPurpose, Routes, type MeView } from '@agentbazaar/contracts';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, inputClass } from '@/components/ui';
import { api, messageOf } from '@/lib/client-api';
import { useI18n } from '@/lib/i18n/context';

/** Grant or withdraw each consent purpose (DPDP). "terms" is shown but cannot be withdrawn here. */
export function ConsentToggles({ consents }: { consents: MeView['consents'] }) {
  const { t } = useI18n();
  const [state, setState] = useState(() => Object.fromEntries(consents.map((c) => [c.purpose, c.granted])));
  const update = useMutation({
    mutationFn: (v: { purpose: ConsentPurpose; granted: boolean }) =>
      api<MeView>(Routes.updateConsent.path, { method: 'PUT', json: v }),
    onSuccess: (me) => setState(Object.fromEntries(me.consents.map((c) => [c.purpose, c.granted]))),
  });
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{t.account.consents}</legend>
      {ConsentPurpose.options.map((purpose) => (
        <div key={purpose} className="flex items-center gap-2">
          <input
            id={`consent-${purpose}`}
            type="checkbox"
            checked={state[purpose] ?? false}
            disabled={purpose === 'terms' || update.isPending}
            onChange={(e) => update.mutate({ purpose, granted: e.target.checked })}
            className="size-5"
          />
          <label htmlFor={`consent-${purpose}`}>{t.account.purposes[purpose]}</label>
        </div>
      ))}
      <p role="status" className="text-sm">
        {update.isSuccess ? t.common.saved : ''}
      </p>
      {update.isError && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {messageOf(update.error, t.errors.unavailable)}
        </p>
      )}
    </fieldset>
  );
}

/** DPDP erasure, guarded by typing ERASE. Signs out afterwards. */
export function EraseAccount() {
  const { t } = useI18n();
  const router = useRouter();
  const [confirm, setConfirm] = useState('');
  const erase = useMutation({
    mutationFn: () => api<unknown>(Routes.eraseAccount.path, { method: 'POST', json: { confirm: 'ERASE' } }),
    onSuccess: async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/account?erased=1');
      router.refresh();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (confirm === 'ERASE') erase.mutate();
      }}
      className="space-y-3"
    >
      <p className="text-sm text-gray-800">{t.account.eraseHint}</p>
      <Field id="erase-confirm" label={t.account.eraseLabel}>
        {(a) => <input {...a} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className={`${inputClass} max-w-xs`} />}
      </Field>
      <Button type="submit" variant="danger" disabled={confirm !== 'ERASE' || erase.isPending}>
        {t.account.eraseButton}
      </Button>
      {erase.isError && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {messageOf(erase.error, t.errors.unavailable)}
        </p>
      )}
    </form>
  );
}

/** TOTP enrolment for admins: shows the secret as text (no QR), then verifies a code. */
export function MfaSetup() {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const setup = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUrl: string }>(Routes.mfaSetup.path, { method: 'POST' }),
  });
  const verify = useMutation({
    mutationFn: () => api<unknown>(Routes.mfaVerify.path, { method: 'POST', json: { code } }),
  });
  if (verify.isSuccess) return <p role="status">{t.account.mfaDone}</p>;
  if (!setup.data) {
    return (
      <div className="space-y-2">
        <Button onClick={() => setup.mutate()} disabled={setup.isPending}>
          {t.account.mfaStart}
        </Button>
        {setup.isError && (
          <p role="alert" className="text-sm font-medium text-red-700">
            {messageOf(setup.error, t.errors.unavailable)}
          </p>
        )}
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate();
      }}
      className="space-y-3"
    >
      <p>{t.account.mfaSecret}</p>
      <p className="break-all rounded-md bg-gray-100 p-3 font-mono text-lg tracking-widest">
        {setup.data.secret.replace(/(.{4})/g, '$1 ').trim()}
      </p>
      <details>
        <summary className="cursor-pointer">{t.account.mfaUri}</summary>
        <code className="block break-all text-sm">{setup.data.otpauthUrl}</code>
      </details>
      <Field id="mfa-code" label={t.account.mfaCode}>
        {(a) => (
          <input
            {...a}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            className={`${inputClass} max-w-40`}
          />
        )}
      </Field>
      <Button type="submit" disabled={code.length !== 6 || verify.isPending}>
        {t.account.mfaVerify}
      </Button>
      {verify.isError && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {messageOf(verify.error, t.errors.unavailable)}
        </p>
      )}
    </form>
  );
}
