import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { addSeconds, type Clock } from '../../../shared/kernel/clock.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { CLOCK, DB, LOGGER } from '../../../shared/kernel/tokens.js';
import type { OutboxEvent, Subscription } from '../../../shared/outbox/outbox.js';
import { AuditService } from '../../audit/index.js';
import { CatalogService } from '../../catalog/index.js';
import { InventoryService } from '../../inventory/index.js';
import { PaymentsService } from '../../payments/index.js';
import { TaxService } from '../../tax/index.js';
import { PAYMENT_WINDOW_S } from './order-placement.js';
import { linesOf, lockOrder, moveOrder, ownerRef, type OrderRow } from './records.js';

/** UPI money seen but not yet in the bank statement: hold stock this long, then hand it to a person. */
const UPI_RECONCILE_S = 72 * 3600;
const AWAITING_PAYMENT = new Set<OrderStatus>(['pending_payment', 'payment_failed', 'payment_observed']);

const payloadOf = (e: OutboxEvent) => e.payload as { orderId?: unknown; status?: unknown };

/** Reacts to payment events and runs the order expiry jobs. Every handler is idempotent. */
@Injectable()
export class OrderLifecycle {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  subscriptions(): Subscription[] {
    return [
      {
        consumer: 'orders-payments',
        topics: ['payment.status_changed'],
        handler: (e, tx) => this.onPaymentStatus(e, tx),
      },
      {
        consumer: 'orders-refunds',
        topics: ['payment.refund_updated'],
        handler: (e, tx) => this.onRefund(e, tx),
      },
    ];
  }

  async onPaymentStatus(event: OutboxEvent, tx: Executor): Promise<void> {
    const { orderId, status } = payloadOf(event);
    const o = typeof orderId === 'string' ? await lockOrder(tx, orderId) : undefined;
    if (!o) return;
    if (status === 'captured' || status === 'reconciled') await this.onSettled(tx, o);
    else if (status === 'observed') await this.onObserved(tx, o);
    else if (status === 'failed') await this.onFailed(tx, o);
  }

  async onRefund(event: OutboxEvent, tx: Executor): Promise<void> {
    const { orderId, status } = payloadOf(event);
    const o = status === 'refunded' && typeof orderId === 'string' ? await lockOrder(tx, orderId) : undefined;
    if (o?.status !== 'returned') return;
    await moveOrder(tx, o, 'refunded', { actor: 'system', at: this.clock.now() });
    await tx.execute(
      sql`UPDATE return_requests SET status = 'refunded', updated_at = now() WHERE order_id = ${o.id} AND status = 'received'`,
    );
  }

  /** Money is in: commit stock, issue the GST invoice. Stock that lapsed is taken again, or the money goes back. */
  private async onSettled(tx: Executor, o: OrderRow): Promise<void> {
    if (o.status === 'cancelled' || o.status === 'expired') {
      await this.audit.record(tx, 'system', 'payment.after_close', o.id, { status: o.status });
      this.refundAfterCommit(o.id, 'payment_after_close');
      return;
    }
    if (!AWAITING_PAYMENT.has(o.status)) return; // replays, and reconciled after captured, change nothing
    const now = this.clock.now();
    if (!(await this.holdStock(tx, o, PAYMENT_WINDOW_S))) {
      await moveOrder(tx, o, 'cancelled', {
        actor: 'system',
        at: now,
        note: 'Paid after the stock hold lapsed and the item sold out; refunding in full',
      });
      this.refundAfterCommit(o.id, 'out_of_stock_after_payment');
      return;
    }
    await this.inventory.commit(tx, ownerRef(o.id));
    const lines = await linesOf(tx, [o.id]);
    const invoice = await this.tax.issueInvoice(
      tx,
      o.id,
      o.place_of_supply,
      lines.map((l) => ({
        sku: l.sku,
        productName: l.product_name,
        hsnCode: l.hsn_code,
        quantity: l.quantity,
        unitPricePaise: l.unit_price_paise,
        totalPaise: l.total_paise,
        taxablePaise: l.taxable_paise,
        taxes: l.taxes,
      })),
    );
    const productIds = new Set<string>();
    for (const l of lines) {
      const p = await this.catalog.productIdForVariant(l.variant_id, tx);
      if (p) productIds.add(p);
    }
    await moveOrder(tx, o, 'paid', {
      actor: 'system',
      at: now,
      set: sql`invoice_number = ${invoice}`,
      payload: { productIds: [...productIds] },
    });
  }

  /** UPI money seen but not settled: hold the stock until the bank statement confirms it. Nothing ships yet. */
  private async onObserved(tx: Executor, o: OrderRow): Promise<void> {
    if (o.status !== 'pending_payment' && o.status !== 'payment_failed') return;
    const now = this.clock.now();
    if (!(await this.holdStock(tx, o, UPI_RECONCILE_S))) {
      // Nothing to refund yet; if the payment is ever reconciled, onSettled refunds it.
      await moveOrder(tx, o, 'cancelled', {
        actor: 'system',
        at: now,
        note: 'Payment seen after the stock hold lapsed and the item sold out',
      });
      return;
    }
    await moveOrder(tx, o, 'payment_observed', {
      actor: 'system',
      at: now,
      note: 'UPI payment seen; waiting for bank reconciliation',
      set: sql`payment_expires_at = ${addSeconds(now, UPI_RECONCILE_S)}`,
    });
  }

  /** The buyer may retry until the payment window closes. */
  private async onFailed(tx: Executor, o: OrderRow): Promise<void> {
    if (o.status !== 'pending_payment' && o.status !== 'payment_observed') return;
    const now = this.clock.now();
    if (o.status === 'payment_observed') {
      // The long UPI hold no longer applies: back to a normal payment window.
      await this.inventory.transfer(tx, ownerRef(o.id), ownerRef(o.id), PAYMENT_WINDOW_S);
      await moveOrder(tx, o, 'payment_failed', {
        actor: 'system',
        at: now,
        set: sql`payment_expires_at = ${addSeconds(now, PAYMENT_WINDOW_S)}`,
      });
      return;
    }
    await moveOrder(tx, o, 'payment_failed', {
      actor: 'system',
      at: now,
      note: 'Payment failed; the buyer can retry',
    });
  }

  /** Keeps (or extends) the order's stock hold, re-reserving if it lapsed. False when the stock is gone. */
  private async holdStock(tx: Executor, o: OrderRow, ttlSeconds: number): Promise<boolean> {
    const owner = ownerRef(o.id);
    if (await this.inventory.isHeld(tx, owner)) {
      await this.inventory.transfer(tx, owner, owner, ttlSeconds);
      return true;
    }
    try {
      // Savepoint: a partial re-reservation must not survive a sold-out line.
      await inTransaction(tx, async (sp) => {
        await this.inventory.release(sp, owner);
        const lines = await linesOf(sp, [o.id]);
        await this.inventory.reserve(
          sp,
          lines.map((l) => ({ variantId: l.variant_id, quantity: l.quantity })),
          owner,
          ttlSeconds,
        );
      });
      return true;
    } catch (e) {
      if (e instanceof AppError && e.code === 'out_of_stock') return false;
      throw e;
    }
  }

  /**
   * Consumers run inside the event's transaction, where the gateway must never be called. The
   * order row lock that transaction holds makes this wait until it commits; then it refunds alone.
   * shortcut: a crash between that commit and the refund leaves an audit row ('payment.after_close' or a
   * cancelled order) but no automatic retry; add a refund sweep if that ever matters in practice.
   */
  private refundAfterCommit(orderId: string, reason: string): void {
    void (async () => {
      const o = await one<{ status: OrderStatus }>(
        this.db,
        sql`SELECT status FROM orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (o?.status === 'cancelled' || o?.status === 'expired') await this.payments.refund(orderId, reason);
    })().catch(async (err: unknown) => {
      this.logger.error({ err, reason }, 'refund after payment failed; recorded for manual follow-up');
      await this.audit
        .record(null, 'system', 'payment.refund_failed', orderId, { reason })
        .catch(() => undefined);
    });
  }

  /** Job: online orders not paid in time give their stock back. */
  async expireUnpaid(tx: Executor): Promise<number> {
    const now = this.clock.now();
    const due = await rows<OrderRow>(
      tx,
      sql`SELECT * FROM orders WHERE status IN ('pending_payment', 'payment_failed') AND payment_expires_at <= ${now}
          ORDER BY payment_expires_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
    );
    for (const o of due) {
      await moveOrder(tx, o, 'expired', { actor: 'system', at: now, note: 'Not paid in time' });
      await this.inventory.release(tx, ownerRef(o.id), 'expired');
    }
    return due.length;
  }

  /** Job: UPI payments seen but never reconciled are cancelled and handed to a person. */
  async cancelUnreconciled(tx: Executor): Promise<number> {
    const now = this.clock.now();
    const due = await rows<OrderRow>(
      tx,
      sql`SELECT * FROM orders WHERE status = 'payment_observed' AND payment_expires_at <= ${now}
          ORDER BY payment_expires_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
    );
    for (const o of due) {
      await moveOrder(tx, o, 'cancelled', {
        actor: 'system',
        at: now,
        note: 'UPI payment was not reconciled within 72 hours',
      });
      await this.inventory.release(tx, ownerRef(o.id), 'expired');
      await this.audit.record(tx, 'system', 'payment.unreconciled', o.id, {
        number: o.number,
        followUp: 'check the bank statement',
      });
    }
    return due.length;
  }
}
