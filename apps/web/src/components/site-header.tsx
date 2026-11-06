import Link from 'next/link';
import { setLanguage } from '@/app/actions';
import { getI18n } from '@/lib/i18n/server';
import { getSession } from '@/lib/session';
import { buttonClass, inputClass } from './ui';

export async function SiteHeader() {
  const [{ t }, session] = await Promise.all([getI18n(), getSession()]);
  return (
    <header className="border-b border-gray-300 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/" className="text-xl font-bold text-blue-800 no-underline">
          {t.site.name}
        </Link>
        <form action="/search" method="get" role="search" className="order-last flex w-full gap-2 md:order-none md:w-auto md:flex-1">
          <label htmlFor="site-search" className="sr-only">
            {t.nav.searchLabel}
          </label>
          <input id="site-search" name="q" type="search" placeholder={t.nav.searchPlaceholder} className={inputClass} />
          <button type="submit" className={buttonClass()}>
            {t.nav.searchButton}
          </button>
        </form>
        <nav aria-label={t.nav.main} className="ml-auto">
          <ul className="flex items-center gap-4 text-sm font-medium">
            <li>
              <Link href="/cart">{t.nav.cart}</Link>
            </li>
            <li>
              <Link href="/account">{t.nav.account}</Link>
            </li>
            {session.role === 'admin' && (
              <li>
                <Link href="/admin">{t.nav.admin}</Link>
              </li>
            )}
            <li>
              <form action={setLanguage}>
                <input type="hidden" name="lang" value={t.nav.otherLanguageCode} />
                <button type="submit" lang={t.nav.otherLanguageCode} className="min-h-11 px-1 text-blue-800 underline">
                  {t.nav.otherLanguage}
                </button>
              </form>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
