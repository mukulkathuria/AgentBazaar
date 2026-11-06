import { Routes, type ReviewItemView } from '@agentbazaar/contracts';
import type { z } from 'zod';
import { ActionButton } from '@/components/action-button';
import { AdminError, AdminTitle, DataTable } from '@/components/admin/admin-ui';
import { formatDateTime } from '@/lib/format';
import { apiPath } from '@/lib/http';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

/** Flagged customization text. Buyer text is rendered as plain text only (React escapes it). */
export default async function ReviewsPage() {
  const { lang, t } = await getI18n();
  const res = await callApi<z.infer<typeof ReviewItemView>[]>(Routes.adminReviews.path);
  if (!res.ok) return <AdminError res={res} t={t} />;
  const tr = t.admin.reviews;

  return (
    <>
      <AdminTitle>{t.admin.sections.reviews}</AdminTitle>
      <DataTable
        caption={t.admin.sections.reviews}
        head={[tr.sku, tr.field, tr.text, tr.flags, t.admin.status, t.admin.created, t.admin.actions]}
        empty={t.admin.empty}
        rows={res.data.map((r) => {
          const decide = apiPath(Routes.adminDecideReview.path, { id: r.id });
          return {
            key: r.id,
            cells: [
              <span key="sku" className="font-mono text-xs">{r.sku}</span>,
              r.field,
              <q key="text" className="whitespace-pre-wrap break-words">{r.text}</q>,
              r.flags.join(', '),
              r.status,
              formatDateTime(r.createdAt, lang),
              r.status === 'pending' ? (
                <span className="flex flex-wrap gap-2">
                  <ActionButton path={decide} json={{ approve: true }} label={t.admin.approve} variant="primary" />
                  <ActionButton path={decide} json={{ approve: false }} label={t.admin.reject} />
                </span>
              ) : null,
            ],
          };
        })}
      />
    </>
  );
}
