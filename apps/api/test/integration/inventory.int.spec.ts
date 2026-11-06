import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../src/modules/inventory/application/inventory.service.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { AppError } from '../../src/shared/kernel/errors.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import { createTestDb, type TestDb } from '../support/test-db.js';

const T0 = '2026-11-05T10:00:00.000Z';

describe('@lite inventory service (reservations against a real schema)', () => {
  let testDb: TestDb;
  let clock: ManualClock;
  let inventory: InventoryService;
  const db = () => testDb.database.db;
  const q = <T>(text: string, params: unknown[] = []) => testDb.database.query<T>(text, params);

  const stock = async (variantId: string) =>
    (await q<{ on_hand: number; reserved: number }>('SELECT on_hand, reserved FROM stock_levels WHERE variant_id = $1', [variantId]))[0];
  const reservations = (ownerRef: string) =>
    q<{ variant_id: string; quantity: number; status: string; owner_ref: string; expires_at: Date }>(
      'SELECT variant_id, quantity, status, owner_ref, expires_at FROM reservations WHERE owner_ref = $1 ORDER BY variant_id',
      [ownerRef],
    );
  const events = async (variantId: string) =>
    (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'inventory.stock_changed' AND aggregate_id = $1 AND payload = $2::jsonb`,
      [variantId, JSON.stringify({ variantId })],
    ))[0]!.n;
  const variant = async (onHand: number) => {
    const id = randomUUID();
    await inventory.setStock(db(), id, onHand);
    return id;
  };
  const reserve = (lines: { variantId: string; quantity: number }[], owner: string, ttl = 600) =>
    inTransaction(db(), (tx) => inventory.reserve(tx, lines, owner, ttl));

  beforeAll(async () => {
    testDb = await createTestDb({ poolMax: 2 });
  }, 60_000);
  afterAll(async () => testDb.cleanup());
  beforeEach(() => {
    clock = new ManualClock(T0);
    inventory = new InventoryService(db(), clock);
  });

  it('sets stock, announces the change and validates the level', async () => {
    const v = await variant(7);
    expect(await stock(v)).toEqual({ on_hand: 7, reserved: 0 });
    expect(await events(v)).toBe(1);
    await inventory.setStock(db(), v, 0);
    expect(await stock(v)).toEqual({ on_hand: 0, reserved: 0 });
    expect(await events(v)).toBe(2);
    for (const bad of [-1, 2.5, Number.NaN]) {
      await expect(inventory.setStock(db(), v, bad)).rejects.toMatchObject({ code: 'validation_failed', message: 'Stock must be a non-negative integer' });
    }
    expect(await stock(v)).toEqual({ on_hand: 0, reserved: 0 });
  });

  it('never lets a stock update drop below what is already reserved', async () => {
    const v = await variant(10);
    await reserve([{ variantId: v, quantity: 4 }], 'cart:shrink');
    await inventory.setStock(db(), v, 1);
    expect(await stock(v)).toEqual({ on_hand: 4, reserved: 4 });
    await inventory.setStock(db(), v, 9);
    expect(await stock(v)).toEqual({ on_hand: 9, reserved: 4 });
  });

  it('reports availability as on hand minus held, zero for unknown variants and never below zero', async () => {
    const v = await variant(5);
    await reserve([{ variantId: v, quantity: 2 }], 'cart:avail');
    const unknown = randomUUID();
    const map = await inventory.availability([v, unknown]);
    expect([...map.entries()]).toEqual([
      [v, 3],
      [unknown, 0],
    ]);
    expect((await inventory.availability([])).size).toBe(0);
    // A drifted row (reserved above on hand) must not surface as negative stock.
    await q('ALTER TABLE stock_levels DROP CONSTRAINT stock_never_oversold');
    try {
      await q('UPDATE stock_levels SET reserved = on_hand + 3 WHERE variant_id = $1', [v]);
      expect((await inventory.availability([v])).get(v)).toBe(0);
    } finally {
      await q('UPDATE stock_levels SET reserved = 2 WHERE variant_id = $1', [v]);
      await q('ALTER TABLE stock_levels ADD CONSTRAINT stock_never_oversold CHECK (reserved <= on_hand)');
    }
  });

  it('reserves every line or none, merging duplicates and holding until now + ttl', async () => {
    const a = await variant(5);
    const b = await variant(1);
    const before = await events(a);
    const held = await reserve(
      [
        { variantId: a, quantity: 2 },
        { variantId: b, quantity: 1 },
        { variantId: a, quantity: 1 },
      ],
      'cart:ok',
      90,
    );
    expect(Object.fromEntries(held.map((r) => [r.variantId, r.quantity]))).toEqual({ [a]: 3, [b]: 1 });
    expect(held.map((r) => r.variantId)).toEqual([a, b].sort());
    expect(held.every((r) => /^[0-9a-f-]{36}$/.test(r.id))).toBe(true);
    expect(await stock(a)).toEqual({ on_hand: 5, reserved: 3 });
    expect(await events(a)).toBe(before + 1);
    const rows = await reservations('cart:ok');
    expect(rows.map((r) => [r.status, r.expires_at.toISOString()])).toEqual([
      ['held', '2026-11-05T10:01:30.000Z'],
      ['held', '2026-11-05T10:01:30.000Z'],
    ]);

    // b has no units left, so the whole basket fails and a's earlier line rolls back with it.
    const err = await reserve(
      [
        { variantId: a, quantity: 1 },
        { variantId: b, quantity: 1 },
      ],
      'cart:fail',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'out_of_stock',
      message: 'Not enough stock for one or more items',
      details: { variantId: b, requested: 1 },
    });
    expect(await stock(a)).toEqual({ on_hand: 5, reserved: 3 });
    expect(await reservations('cart:fail')).toEqual([]);
  });

  it('can take the last unit but not one more', async () => {
    const v = await variant(2);
    await reserve([{ variantId: v, quantity: 2 }], 'cart:last');
    await expect(reserve([{ variantId: v, quantity: 1 }], 'cart:late')).rejects.toMatchObject({ code: 'out_of_stock' });
    await expect(reserve([{ variantId: randomUUID(), quantity: 1 }], 'cart:ghost')).rejects.toMatchObject({ code: 'out_of_stock' });
  });

  it('commits held units off the shelf exactly once', async () => {
    const v = await variant(6);
    await reserve([{ variantId: v, quantity: 4 }], 'order:1');
    const n = await inTransaction(db(), (tx) => inventory.commit(tx, 'order:1'));
    expect(n).toBe(1);
    expect(await stock(v)).toEqual({ on_hand: 2, reserved: 0 });
    expect((await reservations('order:1')).map((r) => r.status)).toEqual(['committed']);
    expect(await inTransaction(db(), (tx) => inventory.commit(tx, 'order:1'))).toBe(0);
    expect(await stock(v)).toEqual({ on_hand: 2, reserved: 0 });
  });

  it('releases held units back to the shelf, with the given status, exactly once', async () => {
    const v = await variant(6);
    await reserve([{ variantId: v, quantity: 4 }], 'order:2');
    const before = await events(v);
    expect(await inTransaction(db(), (tx) => inventory.release(tx, 'order:2'))).toBe(1);
    expect(await stock(v)).toEqual({ on_hand: 6, reserved: 0 });
    expect((await reservations('order:2')).map((r) => r.status)).toEqual(['released']);
    expect(await events(v)).toBe(before + 1);
    expect(await inTransaction(db(), (tx) => inventory.release(tx, 'order:2'))).toBe(0);
    expect(await events(v)).toBe(before + 1);

    await reserve([{ variantId: v, quantity: 1 }], 'order:3');
    expect(await inTransaction(db(), (tx) => inventory.release(tx, 'order:3', 'expired'))).toBe(1);
    expect((await reservations('order:3')).map((r) => r.status)).toEqual(['expired']);
    expect(await stock(v)).toEqual({ on_hand: 6, reserved: 0 });
  });

  it('moves held reservations to a new owner with a fresh expiry', async () => {
    const a = await variant(3);
    const b = await variant(3);
    await reserve(
      [
        { variantId: a, quantity: 1 },
        { variantId: b, quantity: 2 },
      ],
      'session:1',
      60,
    );
    clock.advance(30_000);
    expect(await inTransaction(db(), (tx) => inventory.transfer(tx, 'session:1', 'order:9', 3600))).toBe(2);
    expect(await reservations('session:1')).toEqual([]);
    const moved = await reservations('order:9');
    expect(moved.map((r) => [r.status, r.expires_at.toISOString()])).toEqual([
      ['held', '2026-11-05T11:00:30.000Z'],
      ['held', '2026-11-05T11:00:30.000Z'],
    ]);
    expect(await inTransaction(db(), (tx) => inventory.transfer(tx, 'session:1', 'order:10', 60))).toBe(0);
  });

  it('counts an owner as holding only while every one of its reservations is still held', async () => {
    const v = await variant(5);
    expect(await inventory.isHeld(db(), 'nobody')).toBe(false);
    await reserve([{ variantId: v, quantity: 1 }], 'held:1');
    expect(await inventory.isHeld(db(), 'held:1')).toBe(true);
    await inTransaction(db(), (tx) => inventory.release(tx, 'held:1'));
    expect(await inventory.isHeld(db(), 'held:1')).toBe(false);
    // One line released while another is still held: the hold is broken.
    await reserve([{ variantId: v, quantity: 1 }], 'held:2');
    await q(`UPDATE reservations SET status = 'expired' WHERE owner_ref = 'held:2'`);
    await reserve([{ variantId: v, quantity: 1 }], 'held:2');
    expect(await inventory.isHeld(db(), 'held:2')).toBe(false);
  });

  it('restocks returned goods and announces it', async () => {
    const v = await variant(1);
    const before = await events(v);
    await inTransaction(db(), (tx) => inventory.restock(tx, v, 2));
    expect(await stock(v)).toEqual({ on_hand: 3, reserved: 0 });
    expect(await events(v)).toBe(before + 1);
  });

  it('sweeps only holds whose expiry has passed, marking them expired', async () => {
    // Start from an empty board: holds left by earlier tests in this file expire a day later.
    clock.advance(86_400_000);
    await inventory.sweepExpired();
    const v = await variant(10);
    await reserve([{ variantId: v, quantity: 2 }], 'sweep:soon', 60);
    await reserve([{ variantId: v, quantity: 3 }], 'sweep:later', 600);
    clock.advance(59_000);
    expect(await inventory.sweepExpired()).toBe(0);
    clock.advance(1_000);
    expect(await inventory.sweepExpired()).toBe(1);
    expect((await reservations('sweep:soon')).map((r) => r.status)).toEqual(['expired']);
    expect((await reservations('sweep:later')).map((r) => r.status)).toEqual(['held']);
    expect(await stock(v)).toEqual({ on_hand: 10, reserved: 3 });
    clock.advance(600_000);
    expect(await inventory.sweepExpired(db())).toBe(1);
    expect(await stock(v)).toEqual({ on_hand: 10, reserved: 0 });
  });
});
