import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AdminNav } from '@/components/admin/admin-nav';
import { SessionRefresher } from '@/components/session-refresher';
import { ErrorState } from '@/components/ui';
import { getI18n } from '@/lib/i18n/server';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t.admin.title, robots: { index: false } };
}

/**
 * UI gate only: needs a session; the API authorises every admin call (admin role + MFA) and pages show its
 * 401/403 reason. Not gated on the role cookie because `TokenResponse.role` is optional in the contract.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { t } = await getI18n();
  const session = await getSession();
  if (session.canRefresh) return <SessionRefresher />;
  if (!session.accessToken) {
    return (
      <ErrorState title={t.admin.title} message={t.admin.signInRequired}>
        <Link href="/account?next=/admin">{t.admin.signIn}</Link>
      </ErrorState>
    );
  }
  return (
    <>
      <AdminNav />
      {children}
    </>
  );
}
