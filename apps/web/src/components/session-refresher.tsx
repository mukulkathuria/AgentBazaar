'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { refreshSession } from '@/lib/client-api';
import { useI18n } from '@/lib/i18n/context';

/** Rendered when the access cookie expired but a refresh cookie exists: rotate tokens, then re-render. */
export function SessionRefresher() {
  const router = useRouter();
  const { t } = useI18n();
  useEffect(() => {
    void refreshSession().then(() => router.refresh());
  }, [router]);
  return <p role="status">{t.account.restoring}</p>;
}
