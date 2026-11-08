'use client';

import { AgentScope, CreateAgentClientInput, Routes, type AgentClientView } from '@agentbazaar/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Alert, Button, Field, inputClass } from '@/components/ui';
import { api, messageOf } from '@/lib/client-api';
import { formErrorMap } from '@/lib/form-errors';
import { useI18n } from '@/lib/i18n/context';

type Client = z.infer<typeof AgentClientView>;

/** Shows a freshly created client's secret exactly once; it lives only in this component's state. */
function SecretOnce({ client }: { client: Client }) {
  const { t } = useI18n();
  const ta = t.admin.agents;
  const [copied, setCopied] = useState(false);
  const secret = client.clientSecret ?? '';
  return (
    <Alert tone="warning" title={ta.secretTitle}>
      <p>{ta.secretNote}</p>
      <dl className="mt-2 space-y-1">
        <dt className="font-medium">{ta.clientId}</dt>
        <dd className="break-all font-mono">{client.clientId}</dd>
        <dt className="font-medium">{ta.secret}</dt>
        <dd className="break-all font-mono">{secret}</dd>
      </dl>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}
      >
        {copied ? ta.copied : ta.copy}
      </Button>
    </Alert>
  );
}

export function AgentClientForm() {
  const { t } = useI18n();
  const ta = t.admin.agents;
  const router = useRouter();
  const form = useForm<z.input<typeof CreateAgentClientInput>, unknown, z.output<typeof CreateAgentClientInput>>({
    resolver: zodResolver(CreateAgentClientInput, { error: formErrorMap(t.form) }),
    defaultValues: { name: '', scopes: ['catalog:read'], quotaPerMinute: 60 },
  });
  const create = useMutation({
    mutationFn: (v: z.output<typeof CreateAgentClientInput>) => api<Client>(Routes.adminCreateAgentClient.path, { method: 'POST', json: v }),
    onSuccess: () => {
      form.reset();
      router.refresh();
    },
  });
  const errors = form.formState.errors;

  return (
    <div className="space-y-4">
      {create.data?.clientSecret && <SecretOnce client={create.data} />}
      <form
        method="post"
        onSubmit={form.handleSubmit((v) => create.mutate(v))}
        noValidate
        aria-labelledby="create-agent"
        className="space-y-3 rounded-lg border border-gray-300 p-4"
      >
        <h2 id="create-agent" className="text-xl font-semibold">
          {ta.create}
        </h2>
        <Field id="agent-name" label={ta.name} error={errors.name?.message}>
          {(a) => <input {...a} {...form.register('name')} className={inputClass} />}
        </Field>
        <fieldset aria-describedby={errors.scopes ? 'agent-scopes-error' : undefined}>
          <legend className="text-sm font-medium">{ta.scopes}</legend>
          {AgentScope.options.map((scope) => (
            <div key={scope} className="flex items-center gap-2">
              <input id={`scope-${scope}`} type="checkbox" value={scope} {...form.register('scopes')} className="size-5" />
              <label htmlFor={`scope-${scope}`} className="font-mono text-sm">
                {scope}
              </label>
            </div>
          ))}
          {errors.scopes && (
            <p id="agent-scopes-error" className="text-sm font-medium text-red-700">
              {errors.scopes.message}
            </p>
          )}
        </fieldset>
        <Field id="agent-quota" label={ta.quota} error={errors.quotaPerMinute?.message}>
          {(a) => <input {...a} type="number" {...form.register('quotaPerMinute', { valueAsNumber: true })} className={`${inputClass} w-40`} />}
        </Field>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? ta.creating : ta.create}
        </Button>
        {create.isError && (
          <p role="alert" className="font-medium text-red-700">
            {messageOf(create.error, t.errors.unavailable)}
          </p>
        )}
      </form>
    </div>
  );
}
