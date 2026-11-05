import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, MigrationError } from '../../src/shared/db/migrator.js';
import { createTestDb, MIGRATIONS_DIR, type TestDb } from '../support/test-db.js';

describe('@lite migrations and schema invariants', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.cleanup());

  const q = <T>(text: string, params?: unknown[]) => t.database.query<T>(text, params);

  it('applies every migration once and is a no-op the second time', async () => {
    const all = loadMigrations(MIGRATIONS_DIR);
    const applied = await q<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(applied.map((r) => r.version)).toEqual(all.map((m) => m.version));
    expect(await migrate(t.database, all)).toEqual([]);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const all = loadMigrations(MIGRATIONS_DIR);
    const tampered = all.map((m, i) => (i === 0 ? { ...m, checksum: 'f'.repeat(64) } : m));
    await expect(migrate(t.database, tampered)).rejects.toBeInstanceOf(MigrationError);
  });

  it('rejects duplicate migration versions', async () => {
    const [first] = loadMigrations(MIGRATIONS_DIR);
    await expect(migrate(t.database, [first!, { ...first!, name: '0001_dup.sql' }])).rejects.toThrow(/Duplicate/);
  });

  it('makes audit, offers and order events append-only', async () => {
    await q(`INSERT INTO audit_log (actor, action) VALUES ('test', 'probe')`);
    await expect(q(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });

  it('cannot oversell even if application code is wrong', async () => {
    const [{ id }] = (await q<{ id: string }>(`SELECT gen_random_uuid() AS id`)) as [{ id: string }];
    await q('INSERT INTO stock_levels (variant_id, on_hand, reserved) VALUES ($1, 5, 0)', [id]);
    await expect(q('UPDATE stock_levels SET reserved = 6 WHERE variant_id = $1', [id])).rejects.toThrow(
      /stock_never_oversold/,
    );
  });

  it('enforces price at or below MRP and a valid SKU format', async () => {
    await q(`INSERT INTO brands (name, slug) VALUES ('B', 'b')`);
    await q(`INSERT INTO categories (path, name) VALUES ('x', 'X')`);
    const [p] = await q<{ id: string }>(
      `INSERT INTO products (slug, name, brand_id, category_id, band, hsn_code)
       SELECT 'p', 'P', b.id, c.id, 'fixed', '1806' FROM brands b, categories c RETURNING id`,
    );
    const insert = (sku: string, price: number, mrp: number) =>
      q('INSERT INTO variants (product_id, sku, title, price_paise, mrp_paise, cost_price_paise) VALUES ($1,$2,$3,$4,$5,0)', [
        p!.id,
        sku,
        'v',
        price,
        mrp,
      ]);
    await expect(insert('OK-1', 200, 100)).rejects.toThrow(/mrp/i);
    await expect(insert('bad sku', 100, 100)).rejects.toThrow(/sku/i);
    await expect(insert('OK-2', 100, 100)).resolves.toBeDefined();
  });

  it('allows only one active quote per negotiation', async () => {
    const [n] = await q<{ id: string }>(
      `INSERT INTO negotiation_sessions (variant_id, sku, product_name, subject, channel, state, band, quantity,
         list_unit_paise, opening_unit_paise, current_ask_paise, max_rounds, expires_at)
       VALUES (gen_random_uuid(), 'S', 'P', 'agent:x', 'mcp', 'quote', 'standard', 1, 100, 100, 100, 3, now() + interval '1 hour')
       RETURNING id`,
    );
    const quote = () =>
      q(
        `INSERT INTO quotes (negotiation_id, variant_id, sku, subject, quantity, unit_price_paise, list_unit_paise, status, expires_at)
         VALUES ($1, gen_random_uuid(), 'S', 'agent:x', 1, 100, 100, 'active', now() + interval '1 hour')`,
        [n!.id],
      );
    await quote();
    await expect(quote()).rejects.toThrow(/quotes_one_active_per_negotiation/);
  });

  it('round-trips int8 money as JS numbers and supports vector search', async () => {
    const [r] = await q<{ v: number }>('SELECT 999999999::bigint AS v');
    expect(r!.v).toBe(999_999_999);
    const [d] = await q<{ d: number }>(`SELECT '[1,0,0]'::vector <=> '[0,1,0]'::vector AS d`);
    expect(d!.d).toBeCloseTo(1);
  });
});
