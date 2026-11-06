import { Routes, type HandoffView } from '@agentbazaar/contracts';
import type { z } from 'zod';
import { ActionButton } from '@/components/action-button';
import { AdminError, AdminTitle, DataTable } from '@/components/admin/admin-ui';
import { formatDateTime } from '@/lib/format';
import { apiPath } from '@/lib/http';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

export default async function HandoffsPage() {
  const { lang, t } = await getI18n();
  const res = await callApi<z.infer<typeof HandoffView>[]>(Routes.adminHandoffs.path);
  if (!res.ok) return <AdminError res={res} t={t} />;

  return (
    <>
      <AdminTitle>{t.admin.sections.handoffs}</AdminTitle>
      <DataTable
        caption={t.admin.sections.handoffs}
        head={[t.admin.handoffs.session, t.admin.handoffs.reason, t.admin.status, t.admin.created, t.admin.actions]}
        empty={t.admin.empty}
        rows={res.data.map((h) => ({
          key: h.id,
          cells: [
            <span key="s" className="font-mono text-xs">{h.sessionId}</span>,
            h.reason,
            h.status,
            formatDateTime(h.createdAt, lang),
            h.status === 'open' ? (
              <ActionButton path={apiPath(Routes.adminResolveHandoff.path, { id: h.id })} label={t.admin.resolve} variant="primary" />
            ) : null,
          ],
        }))}
      />
    </>
  );
}
