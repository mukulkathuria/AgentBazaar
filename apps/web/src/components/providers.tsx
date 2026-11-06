'use client';

import type { Language } from '@agentbazaar/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { Dict } from '@/lib/i18n/en';
import { I18nProvider } from '@/lib/i18n/context';

export function Providers({ lang, t, children }: { lang: Language; t: Dict; children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <I18nProvider lang={lang} t={t}>
        {children}
      </I18nProvider>
    </QueryClientProvider>
  );
}
