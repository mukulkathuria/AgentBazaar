import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Alert } from '@/components/ui';
import { getI18n } from '@/lib/i18n/server';
import { LEGAL_CONTENT, LEGAL_DOCS, type LegalDoc } from '@/lib/legal';

type Props = { params: Promise<{ doc: string }> };

const isDoc = (doc: string): doc is LegalDoc => (LEGAL_DOCS as readonly string[]).includes(doc);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { doc } = await params;
  const { t } = await getI18n();
  return isDoc(doc) ? { title: `${t.legal[doc]} (${t.footer.draft})` } : {};
}

export default async function LegalPage({ params }: Props) {
  const { doc } = await params;
  if (!isDoc(doc)) notFound();
  const { t } = await getI18n();
  return (
    <article className="max-w-3xl space-y-6">
      <h1 className="text-3xl font-bold">
        {t.legal[doc]} <span className="text-lg font-semibold text-amber-800">({t.footer.draft})</span>
      </h1>
      <Alert tone="warning" title={t.legal.draftBanner}>
        {t.legal.englishOnly || undefined}
      </Alert>
      <div lang="en" className="space-y-6">
        {LEGAL_CONTENT[doc].map((section) => (
          <section key={section.heading} className="space-y-2">
            <h2 className="text-xl font-semibold">{section.heading}</h2>
            {section.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
      </div>
    </article>
  );
}
