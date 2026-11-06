import Link from 'next/link';
import { ErrorState } from '@/components/ui';
import { getI18n } from '@/lib/i18n/server';

export default async function NotFound() {
  const { t } = await getI18n();
  return (
    <ErrorState title={t.errors.notFoundTitle} message={t.errors.notFound}>
      <Link href="/">{t.errors.goHome}</Link>
    </ErrorState>
  );
}
