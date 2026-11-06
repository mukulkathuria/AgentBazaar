import { Routes, type DiscountPolicyInput } from '@agentbazaar/contracts';
import { AdminError, AdminTitle } from '@/components/admin/admin-ui';
import { PolicyForm } from '@/components/admin/policy-form';
import { getI18n } from '@/lib/i18n/server';
import { callApi } from '@/lib/server-api';

export default async function PoliciesPage() {
  const { t } = await getI18n();
  const res = await callApi<DiscountPolicyInput[]>(Routes.adminPolicies.path);
  if (!res.ok) return <AdminError res={res} t={t} />;
  return (
    <>
      <AdminTitle>{t.admin.sections.policies}</AdminTitle>
      {res.data.length === 0 && <p>{t.admin.empty}</p>}
      <div className="space-y-6">
        {res.data.map((policy) => (
          <PolicyForm key={policy.band} policy={policy} />
        ))}
      </div>
    </>
  );
}
