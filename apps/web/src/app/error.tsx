'use client';

import { Button, ErrorState } from '@/components/ui';
import { useI18n } from '@/lib/i18n/context';

/** Render errors: a friendly message and a retry, never the error text or stack. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  return (
    <ErrorState title={t.errors.title} message={t.errors.unavailable}>
      <Button onClick={reset}>{t.common.retry}</Button>
    </ErrorState>
  );
}
