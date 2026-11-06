import Link from 'next/link';
import { PUBLIC_API_URL } from '@/lib/env';
import { getI18n } from '@/lib/i18n/server';
import { LEGAL_DOCS } from '@/lib/legal';
import { Badge } from './ui';

export async function SiteFooter() {
  const { t } = await getI18n();
  const grievance = process.env.GRIEVANCE_OFFICER_EMAIL ?? 'grievance@example.com';
  const agentCard = `${PUBLIC_API_URL}/.well-known/agent-card.json`;
  return (
    <footer className="mt-12 border-t border-gray-300 bg-gray-50">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 text-sm md:grid-cols-3">
        <section aria-labelledby="footer-grievance" className="space-y-2">
          <h2 id="footer-grievance" className="text-base font-semibold">
            {t.footer.grievanceTitle}
          </h2>
          <p>
            <a href={`mailto:${grievance}`}>{grievance}</a>
          </p>
          <p className="text-gray-700">{t.footer.grievanceBody}</p>
        </section>
        <section aria-labelledby="footer-policies" className="space-y-2">
          <h2 id="footer-policies" className="text-base font-semibold">
            {t.footer.policies}
          </h2>
          <ul className="space-y-1">
            {LEGAL_DOCS.map((doc) => (
              <li key={doc} className="flex items-center gap-2">
                <Link href={`/legal/${doc}`}>{t.legal[doc]}</Link>
                <Badge tone="warning">{t.footer.draft}</Badge>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="footer-agents" className="space-y-2">
          <h2 id="footer-agents" className="text-base font-semibold">
            {t.footer.agentsTitle}
          </h2>
          <p className="text-gray-700">{t.footer.agentsBody}</p>
          <dl className="space-y-1">
            <dt className="font-medium">{t.footer.mcp}</dt>
            <dd>
              <code className="break-all">{`${PUBLIC_API_URL}/mcp`}</code>
            </dd>
            <dt className="font-medium">{t.footer.agentCard}</dt>
            <dd>
              <a href={agentCard} className="break-all">
                <code>{agentCard}</code>
              </a>
            </dd>
          </dl>
          <p>
            <a href="/llms.txt">{t.footer.llms}</a>
          </p>
        </section>
      </div>
      <p className="pb-6 text-center text-xs text-gray-700">{t.footer.openSource}</p>
    </footer>
  );
}
