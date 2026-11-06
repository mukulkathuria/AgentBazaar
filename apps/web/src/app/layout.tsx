import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { SITE_URL } from '@/lib/env';
import { en } from '@/lib/i18n/en';
import { getI18n } from '@/lib/i18n/server';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${en.site.name} — ${en.site.tagline}`, template: `%s · ${en.site.name}` },
  description: en.site.description,
  applicationName: en.site.name,
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1d4ed8' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang, t } = await getI18n();
  return (
    <html lang={lang}>
      <body className="flex min-h-dvh flex-col font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2"
        >
          {t.nav.skip}
        </a>
        <Providers lang={lang} t={t}>
          <SiteHeader />
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 focus:outline-none">
            {children}
          </main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
