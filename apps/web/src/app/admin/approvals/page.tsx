import { formatInr, Routes, type ApprovalView } from '@agentbazaar/contracts';
import type { z } from 'zod';
import { ActionButton } from '@/components/action-button';
import { AdminError, AdminTitle, DataTable } from '@/components/admin/admin-ui';
import { formatDateTime } from '@/lib/format';
import { apiPath } from '@/lib/http';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

export default async function ApprovalsPage() {
  const { lang, t } = await getI18n();
  const res = await callApi<z.infer<typeof ApprovalView>[]>(Routes.adminApprovals.path);
  if (!res.ok) return <AdminError res={res} t={t} />;
  const ta = t.admin.approvals;
  const inr = (paise: number) => formatInr(paise, lang);

  return (
    <>
      <AdminTitle>{t.admin.sections.approvals}</AdminTitle>
      <DataTable
        caption={t.admin.sections.approvals}
        head={[ta.product, ta.qty, ta.list, ta.requested, ta.discount, t.admin.status, t.admin.created, t.admin.actions]}
        empty={t.admin.empty}
        rows={res.data.map((a) => {
          const decide = apiPath(Routes.adminDecideApproval.path, { id: a.id });
          return {
            key: a.id,
            cells: [
              <>
                {a.productName}
                <span className="block font-mono text-xs text-gray-700">{a.sku}</span>
              </>,
              a.quantity,
              inr(a.listUnitPricePaise),
              inr(a.requestedUnitPricePaise),
              inr(a.discountPaise),
              a.status,
              formatDateTime(a.createdAt, lang),
              a.status === 'pending' ? (
                <span className="flex flex-wrap gap-2">
                  <ActionButton path={decide} json={{ approve: true }} label={t.admin.approve} variant="primary" />
                  <ActionButton path={decide} json={{ approve: false }} label={t.admin.decline} />
                </span>
              ) : null,
            ],
          };
        })}
      />
    </>
  );
}
