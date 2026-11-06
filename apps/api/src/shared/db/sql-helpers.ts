import { sql, type SQL } from 'drizzle-orm';

/** Postgres array literal as one bound parameter, identical on node-postgres and PGlite. */
export function pgArray(values: readonly string[], type: 'uuid' | 'text'): SQL {
  const literal = `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
  return type === 'uuid' ? sql`${literal}::uuid[]` : sql`${literal}::text[]`;
}

export const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;
