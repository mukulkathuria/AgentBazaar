import { formatInr, Routes, type DashboardView } from '@agentbazaar/contracts';
import Link from 'next/link';
import { AdminError, AdminTitle, DataTable } from '@/components/admin/admin-ui';
import { Section } from '@/components/ui';
import { fmt } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-gray-300 p-4">
      <dt className="text-sm text-gray-700">{label}</dt>
      <dd className="text-2xl font-bold">{value}</dd>
    </div>
  );
}

export default async function AdminDashboardPage() {
  const { lang, t } = await getI18n();
  const res = await callApi<DashboardView>(Routes.adminDashboard.path);
  if (!res.ok) return <AdminError res={res} t={t} />;
  const d = res.data;
  const td = t.admin.dashboard;
  const counts = (record: Record<string, number>, label = (k: string) => k) =>
    Object.entries(record).map(([k, v]) => ({ key: k, cells: [label(k), v] }));

  return (
    <>
      <AdminTitle>{t.admin.sections.dashboard}</AdminTitle>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={td.orders} value={fmt(td.ordersPaid, { paid: d.orders.paid, total: d.orders.total })} />
        <Stat label={td.revenue} value={formatInr(d.orders.revenuePaise, lang)} />
        {/* acceptRate is read as a 0–1 fraction. */}
        <Stat label={td.acceptRate} value={pct(d.negotiations.acceptRate)} />
        <Stat label={td.avgDiscount} value={`${(d.negotiations.avgDiscountBps / 100).toFixed(1)}%`} />
        <Stat label={td.conversations} value={d.agents.conversations} />
        <Stat label={td.costPerConversation} value={formatInr(Math.round(d.agents.costPerConversationPaise), lang)} />
        <Stat label={td.llmCalls} value={d.agents.llmCalls} />
        <Stat label={td.tokens} value={d.agents.tokens} />
      </dl>
      <Section id="tiers" title={td.tiers}>
        <DataTable caption={td.tiers} head={[td.tierCol, td.count]} rows={counts(d.agents.tierCounts, (k) => fmt(td.tier, { n: k }))} empty={td.none} />
      </Section>
      <Section id="crawlers" title={td.crawlers}>
        <DataTable caption={td.crawlers} head={[td.source, td.count]} rows={counts(d.geo.crawlerHits)} empty={td.none} />
      </Section>
      <Section id="referrals" title={td.referrals}>
        <DataTable caption={td.referrals} head={[td.source, td.count]} rows={counts(d.geo.aiReferrals)} empty={td.none} />
      </Section>
      <Section id="queues" title={td.queues}>
        <ul className="flex flex-wrap gap-4">
          <li>
            <Link href="/admin/approvals">{t.admin.sections.approvals}</Link>: {d.queues.approvals}
          </li>
          <li>
            <Link href="/admin/reviews">{t.admin.sections.reviews}</Link>: {d.queues.reviews}
          </li>
          <li>
            <Link href="/admin/handoffs">{t.admin.sections.handoffs}</Link>: {d.queues.handoffs}
          </li>
        </ul>
      </Section>
    </>
  );
}
