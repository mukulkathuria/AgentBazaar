import { AdminTitle } from '@/components/admin/admin-ui';
import { AdminOrderActions } from '@/components/admin/order-actions';
import { getI18n } from '@/lib/i18n/server';

export default async function AdminOrdersPage() {
  const { t } = await getI18n();
  return (
    <>
      <AdminTitle>{t.admin.sections.orders}</AdminTitle>
      <AdminOrderActions />
    </>
  );
}
