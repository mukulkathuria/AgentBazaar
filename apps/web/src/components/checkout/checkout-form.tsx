'use client';

import { CompleteCheckoutInput, GST_STATES, Routes, type GstStateCode, type OrderView } from '@agentbazaar/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm, type FieldError } from 'react-hook-form';
import type { z } from 'zod';
import { Button, Field, inputClass } from '@/components/ui';
import { api, messageOf, newIdempotencyKey } from '@/lib/client-api';
import { formErrorMap } from '@/lib/form-errors';
import { apiPath } from '@/lib/http';
import { useI18n } from '@/lib/i18n/context';
import { STATE_NAMES } from '@/lib/states';
import { orderTokenKey, toLocalHref } from '@/lib/urls';

type FormInput = z.input<typeof CompleteCheckoutInput>;

const STATES = (Object.keys(GST_STATES) as GstStateCode[]).sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]));

function nextUrl(order: OrderView): string {
  const orderHref = `/orders/${order.orderId}${order.accessToken ? `?t=${encodeURIComponent(order.accessToken)}` : ''}`;
  if (!order.paymentUrl) return orderHref;
  if (order.accessToken) sessionStorage.setItem(orderTokenKey(order.orderId), order.accessToken);
  return toLocalHref(order.paymentUrl) ?? orderHref;
}

/** Address, contact, payment method and terms, validated with the shared contracts schema. */
export function CheckoutForm({ sessionId, token, terms }: { sessionId: string; token: string; terms: string[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormInput, unknown, CompleteCheckoutInput>({
    resolver: zodResolver(CompleteCheckoutInput, { error: formErrorMap(t.form) }),
    defaultValues: {
      email: '',
      address: { name: '', phone: '', line1: '', line2: '', city: '', stateCode: '' as GstStateCode, pincode: '' },
      paymentMethod: 'online',
      acceptTerms: false as true,
    },
  });
  const { register, formState } = form;
  const err = (e: FieldError | undefined) => e?.message;
  const a = formState.errors.address;

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const order = await api<OrderView>(apiPath(Routes.completeCheckout.path, { id: sessionId }, { t: token }), {
        method: 'POST',
        json: values,
        idempotencyKey,
      });
      const next = nextUrl(order);
      if (next.startsWith('/')) router.push(next);
      else window.location.assign(next);
    } catch (e) {
      setServerError(messageOf(e, t.errors.unavailable));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-lg font-semibold">{t.checkout.contact}</legend>
        <Field id="email" label={t.checkout.email} error={err(formState.errors.email)}>
          {(x) => <input {...x} {...register('email')} type="email" autoComplete="email" className={inputClass} />}
        </Field>
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-lg font-semibold">{t.checkout.address}</legend>
        <Field id="name" label={t.checkout.name} error={err(a?.name)} className="sm:col-span-2">
          {(x) => <input {...x} {...register('address.name')} autoComplete="name" className={inputClass} />}
        </Field>
        <Field id="phone" label={t.checkout.phone} hint={t.checkout.phoneHint} error={err(a?.phone)}>
          {(x) => <input {...x} {...register('address.phone')} type="tel" autoComplete="tel" className={inputClass} />}
        </Field>
        <Field id="pincode" label={t.checkout.pincode} error={err(a?.pincode)}>
          {(x) => <input {...x} {...register('address.pincode')} inputMode="numeric" autoComplete="postal-code" className={inputClass} />}
        </Field>
        <Field id="line1" label={t.checkout.line1} error={err(a?.line1)} className="sm:col-span-2">
          {(x) => <input {...x} {...register('address.line1')} autoComplete="address-line1" className={inputClass} />}
        </Field>
        <Field id="line2" label={t.checkout.line2} error={err(a?.line2)} className="sm:col-span-2">
          {(x) => <input {...x} {...register('address.line2')} autoComplete="address-line2" className={inputClass} />}
        </Field>
        <Field id="city" label={t.checkout.city} error={err(a?.city)}>
          {(x) => <input {...x} {...register('address.city')} autoComplete="address-level2" className={inputClass} />}
        </Field>
        <Field id="stateCode" label={t.checkout.state} error={err(a?.stateCode)}>
          {(x) => (
            <select {...x} {...register('address.stateCode')} autoComplete="address-level1" className={inputClass}>
              <option value="">{t.checkout.chooseState}</option>
              {STATES.map((code) => (
                <option key={code} value={code}>
                  {STATE_NAMES[code]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-lg font-semibold">{t.checkout.payment}</legend>
        {(['online', 'cod'] as const).map((method) => (
          <div key={method} className="flex items-center gap-2">
            <input id={`pm-${method}`} type="radio" value={method} {...register('paymentMethod')} className="size-5" />
            <label htmlFor={`pm-${method}`}>{t.checkout[method]}</label>
          </div>
        ))}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-lg font-semibold">{t.checkout.terms}</legend>
        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-800">
          {terms.map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ul>
        <div className="flex items-start gap-2">
          <input
            id="acceptTerms"
            type="checkbox"
            {...register('acceptTerms')}
            aria-invalid={Boolean(formState.errors.acceptTerms)}
            aria-describedby={formState.errors.acceptTerms ? 'acceptTerms-error' : undefined}
            className="mt-1 size-5"
          />
          <label htmlFor="acceptTerms">{t.checkout.accept}</label>
        </div>
        {formState.errors.acceptTerms && (
          <p id="acceptTerms-error" className="text-sm font-medium text-red-700">
            {formState.errors.acceptTerms.message}
          </p>
        )}
      </fieldset>
      {serverError && (
        <p role="alert" className="font-medium text-red-700">
          {serverError}
        </p>
      )}
      <Button type="submit" disabled={formState.isSubmitting} className="w-full sm:w-auto">
        {formState.isSubmitting ? t.checkout.placing : t.checkout.placeOrder}
      </Button>
    </form>
  );
}
