import { MigrationError, type Migration } from '../../../shared/db/migrator.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { CircuitBreaker, withTimeout } from '../../../shared/resilience/resilience.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * ClickHouse over its HTTP interface with plain fetch (no client library). CLICKHOUSE_URL carries the user,
 * password and database (http://user:password@host:8123/db); fetch refuses credentials inside URLs, so they
 * travel as X-ClickHouse-* headers.
 */
export class ClickHouseHttp {
  readonly database: string;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly breaker = new CircuitBreaker('clickhouse');

  constructor(
    url: string,
    private readonly opts: { fetch?: FetchLike; timeoutMs?: number } = {},
  ) {
    const u = new URL(url);
    this.database = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, '')) || 'default';
    this.base = `${u.protocol}//${u.host}/`;
    this.headers = {
      'x-clickhouse-user': decodeURIComponent(u.username) || 'default',
      'x-clickhouse-key': decodeURIComponent(u.password),
      'x-clickhouse-database': this.database,
    };
  }

  /** Runs one statement; `params` fill `{name:Type}` placeholders server-side. Returns the raw body. */
  exec(statement: string, params: Readonly<Record<string, string | number>> = {}): Promise<string> {
    return this.post(new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [`param_${k}`, String(v)])), statement);
  }

  async query<T>(statement: string, params: Readonly<Record<string, string | number>> = {}): Promise<T[]> {
    const body = await this.exec(`${statement}\nFORMAT JSONEachRow`, params);
    return body
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  }

  /** Inserts rows as JSONEachRow. A repeated `dedupToken` is skipped by the table's deduplication window. */
  async insert(table: string, rows: readonly object[], dedupToken?: string): Promise<void> {
    const search = new URLSearchParams({ query: `INSERT INTO ${table} FORMAT JSONEachRow` });
    if (dedupToken) search.set('insert_deduplication_token', dedupToken);
    await this.post(search, rows.map((r) => JSON.stringify(r)).join('\n'));
  }

  private post(search: URLSearchParams, body: string): Promise<string> {
    const doFetch = this.opts.fetch ?? fetch;
    return this.breaker.exec(() =>
      withTimeout(async (signal) => {
        const res = await doFetch(`${this.base}?${search.toString()}`, { method: 'POST', signal, headers: this.headers, body });
        const text = await res.text();
        // The exception code identifies the failure without echoing SQL or data back to API callers.
        const code = res.headers.get('x-clickhouse-exception-code');
        if (!res.ok) throw new AppError('unavailable', `clickhouse answered HTTP ${res.status}${code ? ` (code ${code})` : ''}`);
        return text;
      }, this.opts.timeoutMs ?? 5000),
    );
  }
}

/**
 * Forward-only migrations for ClickHouse with the Postgres file naming and checksums. ClickHouse has neither
 * transactional DDL nor advisory locks, so every statement must be idempotent (IF NOT EXISTS): instances that
 * boot together just apply the same DDL twice. Statements end with `;` at the end of a line.
 */
export async function migrateClickHouse(ch: ClickHouseHttp, migrations: readonly Migration[]): Promise<string[]> {
  await ch.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version String, name String, checksum String, applied_at DateTime DEFAULT now())
     ENGINE = ReplacingMergeTree ORDER BY version`,
  );
  const rows = await ch.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations FINAL');
  const done = new Map(rows.map((r) => [r.version, r.checksum]));
  const applied: string[] = [];
  for (const m of migrations) {
    const checksum = done.get(m.version);
    if (checksum !== undefined) {
      if (checksum !== m.checksum) throw new MigrationError(`ClickHouse migration ${m.name} was modified after it was applied. Add a new migration instead.`);
      continue;
    }
    for (const statement of m.sql.split(/;[ \t]*(?:\r?\n|$)/).filter((s) => s.replace(/--.*$/gm, '').trim())) await ch.exec(statement);
    await ch.insert('schema_migrations', [{ version: m.version, name: m.name, checksum: m.checksum }]);
    applied.push(m.name);
  }
  return applied;
}
