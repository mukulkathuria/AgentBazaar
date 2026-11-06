import { Routes, type AgentClientView } from '@agentbazaar/contracts';
import type { z } from 'zod';
import { AdminError, AdminTitle, DataTable } from '@/components/admin/admin-ui';
import { AgentClientForm } from '@/components/admin/agent-client-form';
import { Section } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

export default async function AgentClientsPage() {
  const { lang, t } = await getI18n();
  const res = await callApi<z.infer<typeof AgentClientView>[]>(Routes.adminAgentClients.path);
  if (!res.ok) return <AdminError res={res} t={t} />;
  const ta = t.admin.agents;

  return (
    <>
      <AdminTitle>{t.admin.sections.agents}</AdminTitle>
      <AgentClientForm />
      <Section id="agent-list" title={ta.list}>
        <DataTable
          caption={ta.list}
          head={[ta.name, ta.clientId, ta.scopes, ta.quota, t.admin.status, t.admin.created]}
          empty={t.admin.empty}
          rows={res.data.map((c) => ({
            key: c.id,
            cells: [
              c.name,
              <span key="id" className="font-mono text-xs">{c.clientId}</span>,
              c.scopes.join(' '),
              c.quotaPerMinute,
              c.status,
              formatDateTime(c.createdAt, lang),
            ],
          }))}
        />
      </Section>
    </>
  );
}
