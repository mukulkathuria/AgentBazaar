import { Inject, Injectable } from '@nestjs/common';
import type { OrderView, ReturnRequestInput } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { safeEqual, sha256Hex } from '../../../shared/crypto/primitives.js';
import { inTransaction, one, type Executor } from '../../../shared/db/database.js';
import type { Principal } from '../../../shared/http/auth.js';
import { addSeconds, type Clock } from '../../../shared/kernel/clock.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { CLOCK, DB, LOGGER } from '../../../shared/kernel/tokens.js';
import { redact } from '../../../shared/observability/redact.js';
import { AuditService } from '../../audit/index.js';
import { InventoryService } from '../../inventory/index.js';
import { PaymentsService } from '../../payments/index.js';
import { stockCommitted } from '../domain/order-state.js';
import { isUuid } from './locked-line.js';
import { linesOf, lockOrder, moveOrder, orderViews, ownerRef, type OrderRow } from './records.js';

/** Reading orders and the buyer and admin actions on them. */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async view(orderId: string, ex: Executor = this.db): Promise<OrderView> {
    const [v] = isUuid(orderId) ? await orderViews(ex, sql`o.id = ${orderId}`) : [];
    if (!v) throw notFound('Order');
    return v;
  }

  /** For agents (MCP/A2A): only orders whose checkout this subject started. */
  async getForSubject(subject: string, orderId: string): Promise<OrderView> {
    const [v] = isUuid(orderId)
      ? await orderViews(this.db, sql`o.id = ${orderId} AND o.subject = ${subject}`)
      : [];
    if (!v) throw notFound('Order');
    return v;
  }

  /** The owner (signed-in customer or agent) or anyone holding the order's one-time token. */
  async getForCaller(who: Principal, orderId: string, token?: string): Promise<OrderView> {
    const o = isUuid(orderId)
      ? await one<OrderRow>(this.db, sql`SELECT * FROM orders WHERE id = ${orderId}`)
      : undefined;
    assertAccess(o, who, token);
    return this.view(orderId);
  }

  async listForCustomer(who: Principal, limit: number, offset: number): Promise<OrderView[]> {
    if (who.kind !== 'customer') return [];
    return orderViews(
      this.db,
      sql`(o.customer_token = ${who.customerToken} OR o.subject = ${who.subject})`,
      sql`LIMIT ${limit} OFFSET ${offset}`,
    );
  }

  async cancel(who: Principal, orderId: string, token?: string): Promise<OrderView> {
    const wasPaid = await inTransaction(this.db, async (tx) => {
      const o = await this.lockAccessible(tx, who, orderId, token);
      const paid = o.status === 'paid';
      const committed = stockCommitted(o.status);
      await moveOrder(tx, o, 'cancelled', {
        actor: who.subject,
        at: this.clock.now(),
        note: 'Cancelled by the buyer',
      });
      if (committed) await this.restock(tx, o.id);
      else await this.inventory.release(tx, ownerRef(o.id));
      return paid;
    });
    if (wasPaid) await this.refund(orderId, 'cancelled_by_buyer');
    return this.view(orderId);
  }

  /** Whole-order returns: refunds are whole-payment, so an order with any non-returnable line cannot be returned. */
  async requestReturn(
    who: Principal,
    orderId: string,
    token: string | undefined,
    input: ReturnRequestInput,
  ): Promise<OrderView> {
    await inTransaction(this.db, async (tx) => {
      const o = await this.lockAccessible(tx, who, orderId, token);
      if (o.status !== 'delivered' || !o.delivered_at)
        throw new AppError('conflict', 'Only delivered orders can be returned');
      const lines = await linesOf(tx, [o.id]);
      const blocked = lines.filter((l) => l.non_returnable).map((l) => l.sku);
      if (blocked.length)
        throw new AppError('conflict', 'Personalised and non-returnable items cannot be returned', {
          skus: blocked,
        });
      const closes = addSeconds(o.delivered_at, Math.min(...lines.map((l) => l.return_window_days)) * 86_400);
      if (this.clock.now() > closes)
        throw new AppError('conflict', `The return window closed on ${closes.toISOString().slice(0, 10)}`);
      await tx.execute(
        sql`INSERT INTO return_requests (order_id, reason, note, status)
            VALUES (${o.id}, ${input.reason}, ${input.note ? redact(input.note) : null}, 'requested')`,
      );
      await moveOrder(tx, o, 'return_requested', {
        actor: who.subject,
        at: this.clock.now(),
        note: input.reason,
      });
    });
    return this.view(orderId);
  }

  async ship(orderId: string, trackingNumber: string, actor: string): Promise<OrderView> {
    await inTransaction(this.db, async (tx) => {
      const o = await this.lock(tx, orderId);
      await moveOrder(tx, o, 'shipped', {
        actor,
        at: this.clock.now(),
        set: sql`tracking_number = ${trackingNumber}`,
      });
    });
    return this.view(orderId);
  }

  async deliver(orderId: string, actor: string): Promise<OrderView> {
    await inTransaction(this.db, async (tx) => {
      const o = await this.lock(tx, orderId);
      const now = this.clock.now();
      await moveOrder(tx, o, 'delivered', { actor, at: now, set: sql`delivered_at = ${now}` });
      if (o.payment_method === 'cod') await this.payments.markCodCollected(tx, o.id);
    });
    return this.view(orderId);
  }

  /** Goods are back: restock and refund. Calling it again on a returned order retries a failed refund. */
  async completeReturn(orderId: string, actor: string): Promise<OrderView> {
    await inTransaction(this.db, async (tx) => {
      const o = await this.lock(tx, orderId);
      if (o.status === 'returned') return;
      await moveOrder(tx, o, 'returned', { actor, at: this.clock.now() });
      await tx.execute(
        sql`UPDATE return_requests SET status = 'received', updated_at = now() WHERE order_id = ${o.id} AND status = 'requested'`,
      );
      await this.restock(tx, o.id);
    });
    await this.refund(orderId, 'returned');
    return this.view(orderId);
  }

  /** Called after commit, never inside a transaction. A failure is recorded for manual follow-up. */
  async refund(orderId: string, reason: string): Promise<void> {
    try {
      await this.payments.refund(orderId, reason);
    } catch (err) {
      this.logger.error({ err, reason }, 'refund failed; recorded for manual follow-up');
      await this.audit.record(null, 'system', 'payment.refund_failed', orderId, { reason });
    }
  }

  private async restock(tx: Executor, orderId: string): Promise<void> {
    for (const l of await linesOf(tx, [orderId])) await this.inventory.restock(tx, l.variant_id, l.quantity);
  }

  private async lock(tx: Executor, orderId: string): Promise<OrderRow> {
    const o = await lockOrder(tx, orderId);
    if (!o) throw notFound('Order');
    return o;
  }

  private async lockAccessible(
    tx: Executor,
    who: Principal,
    orderId: string,
    token?: string,
  ): Promise<OrderRow> {
    return assertAccess(await lockOrder(tx, orderId), who, token);
  }
}

/** Someone else's order looks exactly like a missing one. An IP hash is not an identity, so guests need the token. */
function assertAccess(o: OrderRow | undefined, who: Principal, token: string | undefined): OrderRow {
  const byToken = !!o && !!token && safeEqual(sha256Hex(token), o.access_token_hash);
  const byOwner =
    !!o &&
    who.kind !== 'anonymous' &&
    (o.subject === who.subject || (who.kind === 'customer' && o.customer_token === who.customerToken));
  if (!o || !(byToken || byOwner)) throw notFound('Order');
  return o;
}
