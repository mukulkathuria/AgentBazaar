'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n/context';

const SECTIONS = [
  ['dashboard', '/admin'],
  ['approvals', '/admin/approvals'],
  ['reviews', '/admin/reviews'],
  ['handoffs', '/admin/handoffs'],
  ['negotiations', '/admin/negotiations'],
  ['policies', '/admin/policies'],
  ['agents', '/admin/agents'],
  ['orders', '/admin/orders'],
] as const;

export function AdminNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <nav aria-label={t.admin.nav} className="mb-6 border-b border-gray-300 pb-3">
      <ul className="flex flex-wrap gap-2">
        {SECTIONS.map(([key, href]) => {
          const current = pathname === href;
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                className={`inline-block rounded-md px-3 py-2 text-sm font-medium ${current ? 'bg-blue-700 text-white no-underline' : ''}`}
              >
                {t.admin.sections[key]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
