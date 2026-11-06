import { describe, expect, it } from 'vitest';
import { MigrationError, type Migration } from '../../../shared/db/migrator.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { toTextMap } from './clickhouse-analytics.store.js';
import { ClickHouseHttp, migrateClickHouse, type FetchLike } from './clickhouse.js';

interface Call {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/** A fake ClickHouse HTTP endpoint: records calls and answers from `reply`. */
function fakeClickHouse(reply: (c: Call) => { status?: number; body?: string; code?: string } = () => ({})) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url: new URL(url), headers: init.headers as Record<string, string>, body: init.body as string };
    calls.push(call);
    const r = reply(call);
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.code ? { 'x-clickhouse-exception-code': r.code } : {} });
  };
  return { calls, ch: new ClickHouseHttp('http://agentbazaar:s3cr%40t@ch.internal:8123/t10_db', { fetch }) };
}

const migration = (version: string, sql: string, checksum = `sum-${version}`): Migration => ({ version, name: `${version}_x.sql`, sql, checksum });

describe('@scale ClickHouse HTTP client', () => {
  it('sends credentials and database as headers, never in the URL', async () => {
    const { calls, ch } = fakeClickHouse();
    await ch.exec('SELECT 1');
    expect(calls[0]!.url.origin).toBe('http://ch.internal:8123');
    expect(calls[0]!.url.username + calls[0]!.url.password).toBe('');
    expect(calls[0]!.headers).toMatchObject({ 'x-clickhouse-user': 'agentbazaar', 'x-clickhouse-key': 's3cr@t', 'x-clickhouse-database': 't10_db' });
    expect(ch.database).toBe('t10_db');
  });

  it('binds parameters server-side and parses JSONEachRow', async () => {
    const { calls, ch } = fakeClickHouse(() => ({ body: '{"n":"2"}\n{"n":"3"}\n' }));
    expect(await ch.query<{ n: string }>('SELECT n FROM t WHERE kind = {kind:String}', { kind: "x' OR 1=1" })).toEqual([{ n: '2' }, { n: '3' }]);
    expect(calls[0]!.url.searchParams.get('param_kind')).toBe("x' OR 1=1");
    expect(calls[0]!.body).toBe('SELECT n FROM t WHERE kind = {kind:String}\nFORMAT JSONEachRow');
  });

  it('inserts JSON rows with a deduplication token', async () => {
    const { calls, ch } = fakeClickHouse();
    await ch.insert('analytics_events', [{ id: 'a' }, { id: 'b' }], 'event-1');
    expect(calls[0]!.url.searchParams.get('query')).toBe('INSERT INTO analytics_events FORMAT JSONEachRow');
    expect(calls[0]!.url.searchParams.get('insert_deduplication_token')).toBe('event-1');
    expect(calls[0]!.body).toBe('{"id":"a"}\n{"id":"b"}');
  });

  it('fails as unavailable with the exception code, without echoing the server text', async () => {
    const { ch } = fakeClickHouse(() => ({ status: 500, code: '62', body: 'Syntax error near secret_column' }));
    const err = await ch.exec('SELEC 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('unavailable');
    expect((err as AppError).message).toBe('clickhouse answered HTTP 500 (code 62)');
  });
});

describe('@scale ClickHouse migration runner', () => {
  it('applies new migrations statement by statement and records them', async () => {
    const { calls, ch } = fakeClickHouse((c) => ({ body: c.body.startsWith('SELECT version') ? '{"version":"0065","checksum":"sum-0065"}\n' : '' }));
    const applied = await migrateClickHouse(ch, [
      migration('0065', 'CREATE TABLE a (x UInt8) ENGINE = Memory;'),
      migration('0066', '-- two statements\nCREATE TABLE b (x UInt8) ENGINE = Memory;\nCREATE TABLE c (x UInt8) ENGINE = Memory;\n-- trailing note\n'),
    ]);
    expect(applied).toEqual(['0066_x.sql']);
    const sent = calls.map((c) => c.body.trim());
    expect(sent.some((b) => b.includes('CREATE TABLE a'))).toBe(false);
    expect(sent.filter((b) => /CREATE TABLE [bc]/.test(b))).toHaveLength(2);
    expect(sent.some((b) => b === '-- trailing note')).toBe(false);
    expect(calls.at(-1)!.body).toBe('{"version":"0066","name":"0066_x.sql","checksum":"sum-0066"}');
  });

  it('refuses a migration that changed after it was applied', async () => {
    const { ch } = fakeClickHouse((c) => ({ body: c.body.startsWith('SELECT version') ? '{"version":"0065","checksum":"old"}\n' : '' }));
    await expect(migrateClickHouse(ch, [migration('0065', 'SELECT 1')])).rejects.toBeInstanceOf(MigrationError);
  });
});

describe('@scale analytics event data in ClickHouse', () => {
  it("reads like Postgres's data->>'key': text values, nulls absent", () => {
    expect(toTextMap({ agent: 'GPTBot', total: 3, ratio: 0.5, inStock: false, q: '', gone: null })).toEqual({
      agent: 'GPTBot',
      total: '3',
      ratio: '0.5',
      inStock: 'false',
      q: '',
    });
  });
});
