'use client';

import { DiscountPolicyInput, Routes } from '@agentbazaar/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useFieldArray, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button, Field, inputClass } from '@/components/ui';
import { api, messageOf } from '@/lib/client-api';
import { fmt } from '@/lib/format';
import { formErrorMap } from '@/lib/form-errors';
import { useI18n } from '@/lib/i18n/context';

type PolicyIn = z.input<typeof DiscountPolicyInput>;
type NumberKey = 'negotiableBps' | 'maxRounds' | 'quoteTtlSeconds' | 'concessionExponent';

/** Edits one band policy; validated client-side with the same schema the API enforces. */
export function PolicyForm({ policy }: { policy: DiscountPolicyInput }) {
  const { t } = useI18n();
  const tp = t.admin.policies;
  const form = useForm<PolicyIn, unknown, DiscountPolicyInput>({
    resolver: zodResolver(DiscountPolicyInput, { error: formErrorMap(t.form) }),
    defaultValues: policy,
  });
  const tiers = useFieldArray({ control: form.control, name: 'volumeTiers' });
  const save = useMutation({
    mutationFn: (v: DiscountPolicyInput) => api<DiscountPolicyInput>(Routes.adminUpdatePolicy.path, { method: 'PUT', json: v }),
  });
  const errors = form.formState.errors;
  const id = (name: string) => `${policy.band}-${name}`;
  const numbers: [NumberKey, string, string?][] = [
    ['negotiableBps', tp.negotiableBps],
    ['maxRounds', tp.maxRounds],
    ['quoteTtlSeconds', tp.quoteTtl],
    ['concessionExponent', tp.exponent, 'any'],
  ];

  return (
    <form
      method="post"
      onSubmit={form.handleSubmit((v) => save.mutate(v))}
      noValidate
      aria-labelledby={id('title')}
      className="space-y-4 rounded-lg border border-gray-300 p-4"
    >
      <h2 id={id('title')} className="text-xl font-semibold">
        {fmt(tp.band, { band: policy.band })}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {numbers.map(([key, label, step]) => (
          <Field key={key} id={id(key)} label={label} error={errors[key]?.message}>
            {(a) => <input {...a} type="number" step={step} {...form.register(key, { valueAsNumber: true })} className={inputClass} />}
          </Field>
        ))}
        <Field id={id('approval')} label={tp.approvalThreshold} error={errors.approvalThresholdPaise?.message}>
          {(a) => (
            <input
              {...a}
              type="number"
              {...form.register('approvalThresholdPaise', { setValueAs: (v: string | number | null) => (v === '' || v === null ? null : Number(v)) })}
              className={inputClass}
            />
          )}
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="font-medium">{tp.tiers}</legend>
        {tiers.fields.map((field, i) => (
          <div key={field.id} className="flex flex-wrap items-end gap-2">
            <Field id={id(`tier-${i}-min`)} label={tp.minQty} error={errors.volumeTiers?.[i]?.minQty?.message}>
              {(a) => <input {...a} type="number" {...form.register(`volumeTiers.${i}.minQty`, { valueAsNumber: true })} className={`${inputClass} w-28`} />}
            </Field>
            <Field id={id(`tier-${i}-bps`)} label={tp.extraBps} error={errors.volumeTiers?.[i]?.extraBps?.message}>
              {(a) => <input {...a} type="number" {...form.register(`volumeTiers.${i}.extraBps`, { valueAsNumber: true })} className={`${inputClass} w-28`} />}
            </Field>
            <Button variant="secondary" onClick={() => tiers.remove(i)}>
              {tp.removeTier}
            </Button>
          </div>
        ))}
        {tiers.fields.length < 10 && (
          <Button variant="secondary" onClick={() => tiers.append({ minQty: 2, extraBps: 0 })}>
            {tp.addTier}
          </Button>
        )}
      </fieldset>
      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? tp.saving : tp.save}
      </Button>
      <p role="status">{save.isSuccess ? t.common.saved : ''}</p>
      {save.isError && (
        <p role="alert" className="font-medium text-red-700">
          {messageOf(save.error, t.errors.unavailable)}
        </p>
      )}
    </form>
  );
}
