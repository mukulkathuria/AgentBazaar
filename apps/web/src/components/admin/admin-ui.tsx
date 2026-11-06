import Link from 'next/link';
import type { ReactNode } from 'react';
import { ErrorState } from '@/components/ui';
import type { Dict } from '@/lib/i18n/en';

/** Error state for admin pages: sign-in prompt on 401, the API's reason on 403 (e.g. MFA required). */
export function AdminError({ res, t }: { res: { status: number; message: string }; t: Dict }) {
  if (res.status === 401) {
    return (
      <ErrorState title={t.admin.title} message={t.admin.signInRequired}>
        <Link href="/account?next=/admin">{t.admin.signIn}</Link>
      </ErrorState>
    );
  }
  return <ErrorState title={t.admin.title} message={res.status === 403 ? res.message : t.errors.unavailable} />;
}

export function AdminTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 text-3xl font-bold">{children}</h1>;
}

/** A table with a header row; renders the empty message when there are no rows. */
export function DataTable({
  caption,
  head,
  rows,
  empty,
}: {
  caption: string;
  head: string[];
  rows: { key: string; cells: ReactNode[] }[];
  empty: string;
}) {
  if (!rows.length) return <p>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-gray-300">
            {head.map((h) => (
              <th key={h} scope="col" className="px-2 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-gray-200 align-top">
              {row.cells.map((cell, i) => (
                <td key={i} className="px-2 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
