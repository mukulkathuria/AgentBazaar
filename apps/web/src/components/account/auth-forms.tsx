'use client';

import { LoginInput, RegisterInput } from '@agentbazaar/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button, Field, inputClass } from '@/components/ui';
import { formErrorMap } from '@/lib/form-errors';
import { errorOf } from '@/lib/http';
import { useI18n } from '@/lib/i18n/context';

/** Posts to a BFF auth route; tokens end up in httpOnly cookies and never reach this code. */
async function postAuth(path: string, body: unknown, fallback: string): Promise<string | null> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const e = errorOf(await res.json().catch(() => null), res.status);
    return res.status < 500 ? e.message : fallback;
  } catch {
    return fallback;
  }
}

function useAfterSignIn(next: string | undefined) {
  const router = useRouter();
  return () => {
    if (next) router.push(next);
    else router.refresh();
  };
}

function LoginForm({ next }: { next?: string }) {
  const { t } = useI18n();
  const done = useAfterSignIn(next);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<z.input<typeof LoginInput>, unknown, LoginInput>({
    resolver: zodResolver(LoginInput, { error: formErrorMap(t.form) }),
    defaultValues: { email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    const error = await postAuth('/api/auth/login', values, t.errors.unavailable);
    setServerError(error);
    if (!error) done();
  });
  return (
    <form method="post" onSubmit={onSubmit} noValidate aria-labelledby="login-heading" className="space-y-3 rounded-lg border border-gray-300 p-4">
      <h2 id="login-heading" className="text-xl font-semibold">
        {t.account.signIn}
      </h2>
      <Field id="login-email" label={t.account.email} error={errors.email?.message}>
        {(a) => <input {...a} {...form.register('email')} type="email" autoComplete="email" className={inputClass} />}
      </Field>
      <Field id="login-password" label={t.account.password} error={errors.password?.message}>
        {(a) => <input {...a} {...form.register('password')} type="password" autoComplete="current-password" className={inputClass} />}
      </Field>
      <Field id="login-totp" label={t.account.totp} hint={t.account.totpHint} error={errors.totp?.message}>
        {(a) => (
          <input
            {...a}
            {...form.register('totp', { setValueAs: (v: string) => v.trim() || undefined })}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className={inputClass}
          />
        )}
      </Field>
      {serverError && (
        <p role="alert" className="font-medium text-red-700">
          {serverError}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t.account.signingIn : t.account.signIn}
      </Button>
    </form>
  );
}

function RegisterForm({ next }: { next?: string }) {
  const { t } = useI18n();
  const done = useAfterSignIn(next);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<z.input<typeof RegisterInput>, unknown, RegisterInput>({
    resolver: zodResolver(RegisterInput, { error: formErrorMap(t.form) }),
    defaultValues: { email: '', password: '', name: '', consents: { terms: false as true, marketing: false } },
  });
  const { errors, isSubmitting } = form.formState;
  const onSubmit = form.handleSubmit(async (values) => {
    const error = await postAuth('/api/auth/register', values, t.errors.unavailable);
    setServerError(error);
    if (!error) done();
  });
  const termsError = errors.consents?.terms?.message;
  return (
    <form method="post" onSubmit={onSubmit} noValidate aria-labelledby="register-heading" className="space-y-3 rounded-lg border border-gray-300 p-4">
      <h2 id="register-heading" className="text-xl font-semibold">
        {t.account.register}
      </h2>
      <Field id="reg-name" label={t.account.name} error={errors.name?.message}>
        {(a) => <input {...a} {...form.register('name')} autoComplete="name" className={inputClass} />}
      </Field>
      <Field id="reg-email" label={t.account.email} error={errors.email?.message}>
        {(a) => <input {...a} {...form.register('email')} type="email" autoComplete="email" className={inputClass} />}
      </Field>
      <Field id="reg-password" label={t.account.password} hint={t.account.passwordHint} error={errors.password?.message}>
        {(a) => <input {...a} {...form.register('password')} type="password" autoComplete="new-password" className={inputClass} />}
      </Field>
      <div className="flex items-start gap-2">
        <input
          id="reg-terms"
          type="checkbox"
          {...form.register('consents.terms')}
          aria-invalid={Boolean(termsError)}
          aria-describedby={termsError ? 'reg-terms-error' : undefined}
          className="mt-1 size-5"
        />
        <label htmlFor="reg-terms">{t.account.acceptTerms}</label>
      </div>
      {termsError && (
        <p id="reg-terms-error" className="text-sm font-medium text-red-700">
          {termsError}
        </p>
      )}
      <div className="flex items-start gap-2">
        <input id="reg-marketing" type="checkbox" {...form.register('consents.marketing')} className="mt-1 size-5" />
        <label htmlFor="reg-marketing">{t.account.marketing}</label>
      </div>
      {serverError && (
        <p role="alert" className="font-medium text-red-700">
          {serverError}
        </p>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t.account.registering : t.account.register}
      </Button>
    </form>
  );
}

export function AuthForms({ next }: { next?: string }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <LoginForm next={next} />
      <RegisterForm next={next} />
    </div>
  );
}
