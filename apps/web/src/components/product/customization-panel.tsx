'use client';

import type {
  CustomizationIssue,
  CustomizationOptions,
  CustomizationValidation,
  CustomizationValues,
} from '@agentbazaar/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Field, inputClass } from '@/components/ui';
import { PATHS } from '@/lib/api-paths';
import { api } from '@/lib/client-api';
import { fmt } from '@/lib/format';
import { apiPath } from '@/lib/http';
import { useI18n } from '@/lib/i18n/context';
import { inr } from '@/lib/money';
import { browserAssetUrl } from '@/lib/urls';

export interface CustomizationState {
  /** Undefined when the shopper did not personalise the item. */
  values: CustomizationValues | undefined;
  /** True when add-to-cart may proceed: nothing required is missing and the latest validation is not a rejection. */
  ready: boolean;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

const hasInput = (v: CustomizationValues) => Object.keys(v.text).length > 0 || Boolean(v.designId);

function DesignPicker({
  options,
  designId,
  onChange,
}: {
  options: CustomizationOptions;
  designId: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const { t } = useI18n();
  if (!options.designs.length) return null;
  const choices = [...(options.designRequired ? [] : [{ id: '', name: t.customize.noDesign, previewUrl: '' }]), ...options.designs];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t.customize.design}</legend>
      <div className="flex flex-wrap gap-2">
        {choices.map((d) => (
          <label
            key={d.id || 'none'}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-gray-400 p-2 has-[:checked]:border-blue-700 has-[:checked]:ring-2 has-[:checked]:ring-blue-700"
          >
            <input
              type="radio"
              name="design"
              value={d.id}
              checked={(designId ?? '') === d.id}
              onChange={() => onChange(d.id || undefined)}
              className="size-4"
            />
            {d.previewUrl && <img src={browserAssetUrl(d.previewUrl)} alt="" className="size-12 rounded object-cover" />}
            <span>{d.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ValidationStatus({ pending, data }: { pending: boolean; data: CustomizationValidation | undefined }) {
  const { t } = useI18n();
  const message = pending
    ? t.customize.checking
    : data && { approved: t.customize.approved, needs_review: t.customize.needsReview, rejected: t.customize.rejected }[data.verdict];
  return (
    <p role="status" className={data?.verdict === 'rejected' && !pending ? 'font-medium text-red-700' : 'text-gray-800'}>
      {message ?? ''}
    </p>
  );
}

/**
 * Personalisation: text fields validated live against the API (debounced), design picker, server-rendered
 * SVG preview and the non-returnable notice shown before add-to-cart.
 */
export function CustomizationPanel({
  sku,
  options,
  onStateChange,
}: {
  sku: string;
  options: CustomizationOptions;
  onStateChange: (state: CustomizationState) => void;
}) {
  const { t, lang } = useI18n();
  const [text, setText] = useState<Record<string, string>>({});
  const [designId, setDesignId] = useState<string | undefined>(undefined);
  const values = useMemo<CustomizationValues>(
    () => ({ text: Object.fromEntries(Object.entries(text).filter(([, v]) => v !== '')), ...(designId ? { designId } : {}) }),
    [text, designId],
  );
  const debounced = useDebounced(values, 400);
  const validation = useQuery({
    queryKey: ['customization', sku, debounced],
    queryFn: () =>
      api<CustomizationValidation>(apiPath(PATHS.validateCustomization, { sku }), { method: 'POST', json: debounced }),
    enabled: hasInput(debounced),
    placeholderData: keepPreviousData,
  });

  const touched = hasInput(values);
  const pending = touched && (debounced !== values || validation.isFetching);
  const needsInput = options.designRequired || options.fields.some((f) => f.required);
  const ready = touched ? !pending && validation.isSuccess && validation.data.verdict !== 'rejected' : !needsInput;
  useEffect(() => onStateChange({ values: touched ? values : undefined, ready }), [onStateChange, touched, values, ready]);

  const result = touched ? validation.data : undefined;
  const issues = result?.issues ?? [];
  const issuesFor = (field: string) => issues.filter((i: CustomizationIssue) => i.field === field);
  const fieldKeys = new Set(options.fields.map((f) => f.key));
  const otherIssues = issues.filter((i) => !fieldKeys.has(i.field));
  const previewUrl = result?.previewUrl;

  return (
    <section aria-labelledby="customize-heading" className="space-y-4 rounded-lg border border-gray-300 p-4">
      <h2 id="customize-heading" className="text-lg font-semibold">
        {t.customize.title}
      </h2>
      {options.fields.map((f) => {
        const value = text[f.key] ?? '';
        const error = issuesFor(f.key).map((i) => i.message).join(' ');
        return (
          <Field
            key={f.key}
            id={`cz-${f.key}`}
            label={f.required ? `${f.label} (${t.customize.required})` : f.label}
            hint={fmt(t.customize.chars, { n: [...value].length, max: f.maxLength })}
            error={error || undefined}
          >
            {(a) => (
              <input
                {...a}
                value={value}
                maxLength={f.maxLength}
                required={f.required}
                autoComplete="off"
                onChange={(e) => setText((prev) => ({ ...prev, [f.key]: e.target.value }))}
                className={inputClass}
              />
            )}
          </Field>
        );
      })}
      <DesignPicker options={options} designId={designId} onChange={setDesignId} />
      {otherIssues.length > 0 && (
        <ul className="list-disc pl-5 text-sm font-medium text-red-700">
          {otherIssues.map((i) => (
            <li key={`${i.field}-${i.code}`}>{i.message}</li>
          ))}
        </ul>
      )}
      <ValidationStatus pending={pending} data={result} />
      {previewUrl && <img src={browserAssetUrl(previewUrl)} alt={t.customize.preview} className="w-full max-w-xs rounded-md border border-gray-300" />}
      {options.surchargePaise > 0 && <p>{fmt(t.customize.surcharge, { price: inr(options.surchargePaise, lang) })}</p>}
      <div role="note" className="rounded-md border-l-4 border-amber-600 bg-amber-50 p-3 text-amber-950">
        <p className="font-semibold">{t.customize.noticeTitle}</p>
        <p className="text-sm">{options.notice}</p>
      </div>
    </section>
  );
}
