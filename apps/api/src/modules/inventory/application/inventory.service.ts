import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import type { Clock } from '../../../shared/kernel/clock.js';
import { addSeconds } from '../../../shared/kernel/clock.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { CLOCK, DB } from '../../../shared/kernel/tokens.js';
import { appendEvent } from '../../../shared/outbox/outbox.js';
import { normaliseLines, type ReserveLine } from '../domain/stock.js';

export interface Reservation {
  id: string;
  variantId: string;
  quantity: number;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async setStock(ex: Executor, variantId: string, onHand: number): Promise<void> {
    if (!Number.isInteger(onHand) || onHand < 0) throw new AppError('validation_failed', 'Stock must be a non-negative integer');
    const updated = await one<{ variant_id: string }>(
      ex,
      sql`INSERT INTO stock_levels (variant_id, on_hand) VALUES (${variantId}, ${onHand})
          ON CONFLICT (variant_id) DO UPDATE SET on_hand = GREATEST(${onHand}, stock_levels.reserved), updated_at = now()
          RETURNING variant_id`,
    );
    if (updated) await appendEvent(ex, 'inventory.stock_changed', variantId, { variantId });
  }

  /** Available units (on hand minus held reservations) per variant. Unknown variants report 0. */
  async availability(variantIds: readonly string[], ex: Executor = this.db): Promise<Map<string, number>> {
    const out = new Map<string, number>(variantIds.map((id) => [id, 0]));
    if (!variantIds.length) return out;
    const found = await rows<{ variant_id: string; available: number }>(
      ex,
      sql`SELECT variant_id, on_hand - reserved AS available FROM stock_levels WHERE variant_id = ANY(${pgArray(variantIds, 'uuid')})`,
    );
    for (const r of found) out.set(r.variant_id, Math.max(0, r.available));
    return out;
  }

  /**
   * All-or-nothing reservation inside the caller's transaction. Each line is one conditional
   * UPDATE, so concurrent buyers can never take more than is on hand.
   */
  async reserve(tx: Executor, lines: readonly ReserveLine[], ownerRef: string, ttlSeconds: number): Promise<Reservation[]> {
    const expiresAt = addSeconds(this.clock.now(), ttlSeconds);
    const out: Reservation[] = [];
    for (const line of normaliseLines(lines)) {
      const r = await one<{ id: string }>(
        tx,
        sql`WITH s AS (
              UPDATE stock_levels SET reserved = reserved + ${line.quantity}, updated_at = now()
              WHERE variant_id = ${line.variantId} AND on_hand - reserved >= ${line.quantity}
              RETURNING variant_id)
            INSERT INTO reservations (variant_id, quantity, owner_ref, status, expires_at)
            SELECT variant_id, ${line.quantity}, ${ownerRef}, 'held', ${expiresAt} FROM s
            RETURNING id`,
      );
      if (!r) {
        throw new AppError('out_of_stock', 'Not enough stock for one or more items', {
          variantId: line.variantId,
          requested: line.quantity,
        });
      }
      out.push({ id: r.id, ...line });
      await appendEvent(tx, 'inventory.stock_changed', line.variantId, { variantId: line.variantId });
    }
    return out;
  }

  /** Converts held reservations into a sale: stock leaves the shelf. Idempotent. */
  async commit(tx: Executor, ownerRef: string): Promise<number> {
    const done = await rows<{ variant_id: string; quantity: number }>(
      tx,
      sql`UPDATE reservations SET status = 'committed', updated_at = now()
          WHERE owner_ref = ${ownerRef} AND status = 'held' RETURNING variant_id, quantity`,
    );
    for (const r of done) {
      await tx.execute(
        sql`UPDATE stock_levels SET on_hand = on_hand - ${r.quantity}, reserved = reserved - ${r.quantity}, updated_at = now()
            WHERE variant_id = ${r.variant_id}`,
      );
    }
    return done.length;
  }

  /** Returns held units to the shelf. Idempotent; only 'held' reservations move. */
  async release(tx: Executor, ownerRef: string, status: 'released' | 'expired' = 'released'): Promise<number> {
    const done = await rows<{ variant_id: string; quantity: number }>(
      tx,
      sql`UPDATE reservations SET status = ${status}, updated_at = now()
          WHERE owner_ref = ${ownerRef} AND status = 'held' RETURNING variant_id, quantity`,
    );
    for (const r of done) {
      await tx.execute(
        sql`UPDATE stock_levels SET reserved = reserved - ${r.quantity}, updated_at = now() WHERE variant_id = ${r.variant_id}`,
      );
      await appendEvent(tx, 'inventory.stock_changed', r.variant_id, { variantId: r.variant_id });
    }
    return done.length;
  }

  /** Moves held reservations to a new owner (checkout session -> order) with a new expiry. */
  async transfer(tx: Executor, fromRef: string, toRef: string, ttlSeconds: number): Promise<number> {
    const expiresAt = addSeconds(this.clock.now(), ttlSeconds);
    const moved = await rows<{ id: string }>(
      tx,
      sql`UPDATE reservations SET owner_ref = ${toRef}, expires_at = ${expiresAt}, updated_at = now()
          WHERE owner_ref = ${fromRef} AND status = 'held' RETURNING id`,
    );
    return moved.length;
  }

  /** True when the owner still holds its reservations (none were expired or released). */
  async isHeld(tx: Executor, ownerRef: string): Promise<boolean> {
    const r = await one<{ held: number; other: number }>(
      tx,
      sql`SELECT count(*) FILTER (WHERE status = 'held')::int AS held, count(*) FILTER (WHERE status <> 'held')::int AS other
          FROM reservations WHERE owner_ref = ${ownerRef}`,
    );
    return (r?.held ?? 0) > 0 && (r?.other ?? 0) === 0;
  }

  /** Physically returned goods go back on the shelf. */
  async restock(tx: Executor, variantId: string, quantity: number): Promise<void> {
    await tx.execute(
      sql`UPDATE stock_levels SET on_hand = on_hand + ${quantity}, updated_at = now() WHERE variant_id = ${variantId}`,
    );
    await appendEvent(tx, 'inventory.stock_changed', variantId, { variantId });
  }

  /** Releases reservations whose hold expired. Run by the scheduler. */
  async sweepExpired(ex: Executor = this.db): Promise<number> {
    return inTransaction(ex, async (tx) => {
      const owners = await rows<{ owner_ref: string }>(
        tx,
        sql`SELECT DISTINCT owner_ref FROM reservations WHERE status = 'held' AND expires_at <= ${this.clock.now()} LIMIT 500`,
      );
      let n = 0;
      for (const o of owners) n += await this.release(tx, o.owner_ref, 'expired');
      return n;
    });
  }
}
