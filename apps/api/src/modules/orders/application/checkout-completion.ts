import { Inject, Injectable } from '@nestjs/common';
import type { CompleteCheckoutInput, OrderView } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import { randomToken, sha256Hex } from '../../../shared/crypto/primitives.js';
import { inTransaction, one, type Executor } from '../../../shared/db/database.js';
import type { Clock } from '../../../shared/kernel/clock.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { CLOCK, DB } from '../../../shared/kernel/tokens.js';
import { InventoryService } from '../../inventory/index.js';
import { CartService } from './cart.service.js';
import {
  WORKFLOW_ENGINE,
  type Buyer,
  type CheckoutSagaInput,
  type PlacedCheckout,
  type WorkflowEngine,
} from './checkout-saga.js';
import {
  CheckoutService,
  SESSION_TTL_S,
  expired,
  reserveLines,
  sessionRef,
  type SessionRow,
} from './checkout.service.js';
import { OrderPlacement, PAYMENT_WINDOW_S, type PlacedOrder } from './order-placement.js';
import { ownerRef } from './records.js';

/**
 * A person completes a checkout. The in-process engine places the order in one transaction; the
 * Temporal engine hands it to the checkout saga, whose first steps (holdSession, placeBySaga) are here.
 */
@Injectable()
export class CheckoutCompletion {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CheckoutService) private readonly sessions: CheckoutService,
    @Inject(CartService) private readonly carts: CartService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OrderPlacement) private readonly placement: OrderPlacement,
    @Inject(WORKFLOW_ENGINE) private readonly saga: WorkflowEngine | null,
  ) {}

  async complete(sessionId: string, token: string, input: CompleteCheckoutInput): Promise<OrderView> {
    this.sessions.verify(sessionId, token);
    if (this.saga) return this.completeBySaga(this.saga, sessionId, input);
    const accessToken = randomToken(24);
    const placed = await inTransaction(this.db, async (tx) => {
      const s = await this.lock(tx, sessionId);
      this.assertOpen(s);
      await this.ensureStock(tx, s);
      return this.placeLocked(tx, s, await this.placement.vaultBuyer(tx, input), sha256Hex(accessToken));
    });
    return this.placement.confirm({ ...placed, accessToken });
  }

  /** Saga step: the session's stock is still held, re-reserved if the hold lapsed. Nothing to do once the order exists. */
  async holdSession(sessionId: string): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      const s = await this.lock(tx, sessionId);
      if (s.status === 'completed') return;
      this.assertOpen(s);
      await this.ensureStock(tx, s);
    });
  }

  /** Saga step: places the order and moves the stock hold onto it. A retry returns the order it already placed. */
  async placeBySaga(input: CheckoutSagaInput): Promise<PlacedCheckout> {
    return inTransaction(this.db, async (tx) => {
      const s = await this.lock(tx, input.sessionId);
      // Only this session's saga completes it, so a completed session means an earlier attempt committed.
      if (s.status === 'completed' && s.order_id)
        return { orderId: s.order_id, method: input.buyer.paymentMethod };
      this.assertOpen(s);
      await this.ensureStock(tx, s);
      const order = await this.placeLocked(tx, s, input.buyer, input.accessTokenHash);
      return { orderId: order.id, method: order.method };
    });
  }

  /** Temporal: the personal data goes to the vault first, so the saga's input and history carry only tokens. */
  private async completeBySaga(
    saga: WorkflowEngine,
    sessionId: string,
    input: CompleteCheckoutInput,
  ): Promise<OrderView> {
    const s = await one<SessionRow>(this.db, sql`SELECT * FROM checkout_sessions WHERE id = ${sessionId}`);
    if (!s) throw notFound('Checkout session');
    this.assertOpen(s);
    const buyer = await inTransaction(this.db, (tx) => this.placement.vaultBuyer(tx, input));
    const accessToken = randomToken(24);
    const placed = await saga.startCheckout({ sessionId, buyer, accessTokenHash: sha256Hex(accessToken) });
    return this.placement.placedBySaga(placed, accessToken);
  }

  /** The rest of the checkout transaction: the order takes over the stock hold and the session closes. */
  private async placeLocked(
    tx: Executor,
    s: SessionRow,
    buyer: Buyer,
    accessTokenHash: string,
  ): Promise<PlacedOrder> {
    const order = await this.placement.place(tx, s, buyer, accessTokenHash);
    const owner = ownerRef(order.id);
    await this.inventory.transfer(tx, sessionRef(s.id), owner, PAYMENT_WINDOW_S);
    if (order.method === 'cod') await this.inventory.commit(tx, owner);
    await tx.execute(
      sql`UPDATE checkout_sessions SET status = 'completed', order_id = ${order.id}, updated_at = now() WHERE id = ${s.id}`,
    );
    if (s.source === 'cart') await this.carts.clear(tx, s.source_ref);
    return order;
  }

  /** Holds normally last as long as the session; if the sweeper released them, take the stock again or fail cleanly. */
  private async ensureStock(tx: Executor, s: SessionRow): Promise<void> {
    const owner = sessionRef(s.id);
    if (await this.inventory.isHeld(tx, owner)) return;
    await this.inventory.release(tx, owner);
    await this.inventory.reserve(tx, reserveLines(s.lines), owner, SESSION_TTL_S);
  }

  private async lock(tx: Executor, sessionId: string): Promise<SessionRow> {
    const s = await one<SessionRow>(
      tx,
      sql`SELECT * FROM checkout_sessions WHERE id = ${sessionId} FOR UPDATE`,
    );
    if (!s) throw notFound('Checkout session');
    return s;
  }

  private assertOpen(s: SessionRow): void {
    if (s.status === 'completed')
      throw new AppError('conflict', 'This checkout is already complete', { orderId: s.order_id });
    if (s.status !== 'open' || s.expires_at <= this.clock.now()) throw expired();
  }
}
