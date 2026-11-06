import { Routes, type MeView } from '@agentbazaar/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthForms } from '@/components/account/auth-forms';
import { ConsentToggles, EraseAccount, MfaSetup } from '@/components/account/privacy-controls';
import { SessionRefresher } from '@/components/session-refresher';
import { Alert, buttonClass, ErrorState, Section } from '@/components/ui';
import { firstParam, type SearchParams } from '@/lib/catalog';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t.account.title, robots: { index: false } };
}

/** Only same-site paths are allowed as post-login destinations. */
const safeNext = (next: string | undefined) => (next?.startsWith('/') && !next.startsWith('//') ? next : undefined);

export default async function AccountPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { t } = await getI18n();
  const sp = await searchParams;
  const session = await getSession();
  if (session.canRefresh) return <SessionRefresher />;
  const me = session.accessToken ? await callApi<MeView>(Routes.me.path) : null;

  if (!me?.ok) {
    if (me && me.status >= 500) return <ErrorState title={t.account.title} message={t.errors.unavailable} />;
    return (
      <>
        <h1 className="mb-4 text-3xl font-bold">{t.account.title}</h1>
        {firstParam(sp.erased) && (
          <div className="mb-4">
            <Alert tone="success">{t.account.erased}</Alert>
          </div>
        )}
        <AuthForms next={safeNext(firstParam(sp.next))} />
      </>
    );
  }

  const profile = me.data;
  return (
    <>
      <h1 className="mb-4 text-3xl font-bold">{t.account.title}</h1>
      <Section id="profile" title={t.account.profile}>
        <dl className="grid max-w-md grid-cols-2 gap-1">
          <dt className="font-medium">{t.account.name}</dt>
          <dd>{profile.name ?? '—'}</dd>
          <dt className="font-medium">{t.account.email}</dt>
          <dd className="break-all">{profile.email ?? '—'}</dd>
          <dt className="font-medium">{t.account.role}</dt>
          <dd>{t.account.roles[profile.role]}</dd>
        </dl>
        <div className="flex flex-wrap gap-3">
          <Link href="/account/orders" className={buttonClass('secondary')}>
            {t.account.orders}
          </Link>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className={buttonClass('secondary')}>
              {t.nav.signOut}
            </button>
          </form>
        </div>
      </Section>
      {profile.role === 'admin' && (
        <Section id="mfa" title={t.account.mfaTitle}>
          {profile.mfaEnabled ? <p>{t.account.mfaOn}</p> : <MfaSetup />}
        </Section>
      )}
      <Section id="consents" title={t.account.consents}>
        <ConsentToggles consents={profile.consents} />
      </Section>
      <Section id="export" title={t.account.exportTitle}>
        <p className="text-sm text-gray-800">{t.account.exportHint}</p>
        <a href={`/api/proxy${Routes.exportData.path}`} download="agentbazaar-data-export.json" className={buttonClass('secondary')}>
          {t.account.export}
        </a>
      </Section>
      <Section id="erase" title={t.account.eraseTitle}>
        <EraseAccount />
      </Section>
    </>
  );
}
