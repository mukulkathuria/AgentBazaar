import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach } from 'vitest';
import { Providers } from '@/components/providers';
import { en } from '@/lib/i18n/en';

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

/** Renders inside the app providers (TanStack Query + English dictionary). */
export function renderWithProviders(ui: ReactElement) {
  return render(
    <Providers lang="en" t={en}>
      {ui}
    </Providers>,
  );
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
