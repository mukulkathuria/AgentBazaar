import { formatInr, Routes, type NegotiationSummaryView } from '@agentbazaar/contracts';
import Link from 'next/link';
import type { z } from 'zod';
import { AdminError, AdminTitle, DataTable } from '@/components/admin/admin-ui';
import { firstParam, type SearchParams } from '@/lib/catalog';
import { formatDateTime } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

const LIMIT = 20;

export default async function NegotiationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { lang, t } = await getI18n();
  const raw = Number(firstParam((await searchParams).offset) ?? 0);
  const offset = Number.isInteger(raw) && raw >= 0 ? Math.min(raw, 10_000) : 0;
  const res = await callApi<z.infer<typeof NegotiationSummaryView>[]>(Routes.adminNegotiations.path, {
    query: { limit: LIMIT, offset },
  });
  if (!res.ok) return <AdminError res={res} t={t} />;
  const tn = t.admin.negotiations;
  const inr = (paise: number | null) => (paise === null ? '—' : formatInr(paise, lang));

  return (
    <>
      <AdminTitle>{t.admin.sections.negotiations}</AdminTitle>
      {res.data.length === 0 && <p>{t.admin.empty}</p>}
      <ul className="space-y-3">
        {res.data.map((n) => (
          <li key={n.negotiationId} className="rounded-lg border border-gray-300">
            <details className="p-3">
              <summary className="cursor-pointer">
                <span className="font-mono text-sm">{n.sku}</span> · {tn.channel}: {n.channel} · {tn.state}: {n.state} · {tn.rounds}:{' '}
                {n.rounds} · {tn.list}: {inr(n.listUnitPricePaise)} · {tn.final}: {inr(n.finalUnitPricePaise)} ·{' '}
                {formatDateTime(n.createdAt, lang)}
              </summary>
              <div className="mt-3">
                <DataTable
                  caption={`${tn.channel} ${n.channel}`}
                  head={[tn.at, tn.actor, tn.price, tn.qty, tn.decision]}
                  empty={t.admin.empty}
                  rows={n.offers.map((o, i) => ({
                    key: `${n.negotiationId}-${i}`,
                    cells: [formatDateTime(o.at, lang), o.actor, inr(o.unitPricePaise), o.quantity, o.decision],
                  }))}
                />
              </div>
            </details>
          </li>
        ))}
      </ul>
      <nav aria-label={t.common.pagination} className="mt-4 flex justify-between">
        {offset > 0 ? <Link href={`/admin/negotiations?offset=${Math.max(0, offset - LIMIT)}`}>{t.common.previous}</Link> : <span />}
        {res.data.length === LIMIT ? <Link href={`/admin/negotiations?offset=${offset + LIMIT}`}>{t.common.next}</Link> : <span />}
      </nav>
    </>
  );
}
