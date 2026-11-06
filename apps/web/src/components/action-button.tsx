'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { api, messageOf } from '@/lib/client-api';
import { useI18n } from '@/lib/i18n/context';

/** POSTs to an API path through the proxy, then re-renders the server page. */
export function ActionButton({
  path,
  json,
  label,
  variant = 'secondary',
}: {
  path: string;
  json?: unknown;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const router = useRouter();
  const { t } = useI18n();
  const action = useMutation({
    mutationFn: () => api<unknown>(path, { method: 'POST', json }),
    onSuccess: () => router.refresh(),
  });
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant={variant} disabled={action.isPending} onClick={() => action.mutate()}>
        {label}
      </Button>
      {action.isError && (
        <span role="alert" className="text-sm font-medium text-red-700">
          {messageOf(action.error, t.errors.unavailable)}
        </span>
      )}
    </span>
  );
}
