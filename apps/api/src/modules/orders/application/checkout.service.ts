import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type {
  CheckoutLink,
  CheckoutSessionView,
  CompleteCheckoutInput,
  OrderView,
} from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import { signToken, verifyToken, type KeyRing } from '../../../shared/crypto/keyring.js';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import { addSeconds, type Clock } from '../../../shared/kernel/clock.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { CLOCK, CONFIG, DB, KEYS } from '../../../shared/kernel/tokens.js';
import { InventoryService } from '../../inventory/index.js';
import { NegotiationService } from '../../pricing/index.js';
import { CartService } from './cart.service.js';
import { isUuid, type LockedLine } from './locked-line.js';
import { OrderPlacement, PAYMENT_WINDOW_S } from './order-placement.js';
import { ownerRef } from './records.js';

/** Prices and stock are held this long while a person confirms address and payment. */
export const SESSION_TTL_S = 1800;

interface SessionRow {
  id: string;
  source: 'cart' | 'quote';
  source_ref: string;
  subject: string;
  lines: LockedLine[];
  subtotal_paise: number;
  status: CheckoutSessionView['status'];
  expires_at: Date;
  order_id: string | null;
}

const sessionRef = (id: string): string => `checkout:${id}`;
const reserveLines = (lines: readonly LockedLine[]) =>
  lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
const expired = () =>
  new AppError('conflict', 'This checkout has expired. Start again from your cart or ask for a new quote.');

/**
 * Checkout sessions lock prices and reserve stock in one transaction, and hand out a capability
 * token. Agents can start one, but only a person completes it (address, payment method, terms).
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(KEYS) private readonly keys: KeyRing,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CartService) private readonly carts: CartService,
    @Inject(NegotiationService) private readonly negotiations: NegotiationService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OrderPlacement) private readonly placement: OrderPlacement,
  ) {}

  startFromCart(subject: string, cartId: string): Promise<CheckoutSessionView> {
    return this.open(subject, 'cart', async (tx) => ({
      ref: cartId,
      lines: await this.carts.lockLines(tx, cartId),
    }));
  }

  /** Consumes the quote (single use, bound to the subject it was issued to) in the same transaction. */
  startFromQuote(subject: string, quoteToken: string): Promise<CheckoutSessionView> {
    return this.open(subject, 'quote', async (tx) => {
      const q = await this.negotiations.acceptQuote(tx, subject, quoteToken);
      return { ref: q.quoteId, lines: [await this.carts.lockQuote(tx, q)] };
    });
  }

  async get(sessionId: string, token: string): Promise<CheckoutSessionView> {
    this.verify(sessionId, token);
    const s = await one<SessionRow>(this.db, sql`SELECT * FROM checkout_sessions WHERE id = ${sessionId}`);
    if (!s) throw notFound('Checkout session');
    return this.view(s);
  }

  /** The page where a person confirms the order. The token in it is the session's capability. */
  async linkFor(sessionId: string, token: string): Promise<CheckoutLink> {
    const s = await this.get(sessionId, token);
    if (s.status !== 'open')
      throw s.status === 'expired' ? expired() : new AppError('conflict', `This checkout is ${s.status}`);
    return {
      sessionId,
      url: `${this.config.env.PUBLIC_WEB_URL.replace(/\/$/, '')}/checkout/${sessionId}?t=${token}`,
      expiresAt: s.expiresAt,
      amountPaise: s.subtotalPaise,
      currency: 'INR',
    };
  }

  async complete(sessionId: string, token: string, input: CompleteCheckoutInput): Promise<OrderView> {
    this.verify(sessionId, token);
    const placed = await inTransaction(this.db, async (tx) => {
      const s = await one<SessionRow>(
        tx,
        sql`SELECT * FROM checkout_sessions WHERE id = ${sessionId} FOR UPDATE`,
      );
      if (!s) throw notFound('Checkout session');
      if (s.status === 'completed')
        throw new AppError('conflict', 'This checkout is already complete', { orderId: s.order_id });
      if (s.status !== 'open' || s.expires_at <= this.clock.now()) throw expired();
      await this.ensureStock(tx, s);
      const order = await this.placement.place(tx, s, input);
      const owner = ownerRef(order.id);
      await this.inventory.transfer(tx, sessionRef(s.id), owner, PAYMENT_WINDOW_S);
      if (order.method === 'cod') await this.inventory.commit(tx, owner);
      await tx.execute(
        sql`UPDATE checkout_sessions SET status = 'completed', order_id = ${order.id}, updated_at = now() WHERE id = ${s.id}`,
      );
      if (s.source === 'cart') await this.carts.clear(tx, s.source_ref);
      return order;
    });
    return this.placement.confirm(placed);
  }

  /** Scheduler job: open sessions past their expiry give their stock back. */
  async expireSessions(tx: Executor): Promise<number> {
    const due = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM checkout_sessions WHERE status = 'open' AND expires_at <= ${this.clock.now()}
          ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED`,
    );
    for (const s of due) {
      await tx.execute(
        sql`UPDATE checkout_sessions SET status = 'expired', updated_at = now() WHERE id = ${s.id}`,
      );
      await this.inventory.release(tx, sessionRef(s.id), 'expired');
    }
    return due.length;
  }

  private async open(
    subject: string,
    source: SessionRow['source'],
    lock: (tx: Executor) => Promise<{ ref: string; lines: LockedLine[] }>,
  ): Promise<CheckoutSessionView> {
    const view = await inTransaction(this.db, async (tx) => {
      const { ref, lines } = await lock(tx);
      const subtotal = lines.reduce((sum, l) => sum + l.totalPaise, 0);
      const s = await one<SessionRow>(
        tx,
        sql`INSERT INTO checkout_sessions (source, source_ref, subject, lines, subtotal_paise, status, expires_at)
            VALUES (${source}, ${ref}, ${subject}, ${json(lines)}, ${subtotal}, 'open', ${addSeconds(this.clock.now(), SESSION_TTL_S)})
            RETURNING *`,
      );
      // All or nothing: a line that cannot be reserved rolls back the session (and the quote stays usable).
      await this.inventory.reserve(tx, reserveLines(lines), sessionRef(s!.id), SESSION_TTL_S);
      return this.view(s!);
    });
    const exp = Math.floor(new Date(view.expiresAt).getTime() / 1000);
    return { ...view, token: signToken(this.keys.quoteKey, 'checkout', { sid: view.sessionId, exp }) };
  }

  /** Holds normally last as long as the session; if the sweeper released them, take the stock again or fail cleanly. */
  private async ensureStock(tx: Executor, s: SessionRow): Promise<void> {
    const owner = sessionRef(s.id);
    if (await this.inventory.isHeld(tx, owner)) return;
    await this.inventory.release(tx, owner);
    await this.inventory.reserve(tx, reserveLines(s.lines), owner, SESSION_TTL_S);
  }

  /** A forged token, or one for another session, reads as "not found". */
  private verify(sessionId: string, token: string): void {
    const v = verifyToken<{ sid: string; exp: number }>(
      this.keys.quoteKey,
      'checkout',
      token,
      this.clock.now(),
    );
    if (v.ok && v.payload.sid === sessionId && isUuid(sessionId)) return;
    throw !v.ok && v.reason === 'expired' ? expired() : notFound('Checkout session');
  }

  private view(s: SessionRow): CheckoutSessionView {
    const nonReturnable = s.lines.some((l) => l.nonReturnable);
    return {
      sessionId: s.id,
      status: s.status === 'open' && s.expires_at <= this.clock.now() ? 'expired' : s.status,
      lines: s.lines.map((l) => ({
        sku: l.sku,
        productName: l.productName,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        totalPaise: l.totalPaise,
        nonReturnable: l.nonReturnable,
        customization: l.customization,
      })),
      subtotalPaise: s.subtotal_paise,
      currency: 'INR',
      expiresAt: s.expires_at.toISOString(),
      source: s.source,
      terms: [
        'Prices include GST.',
        `Prices and stock are held until ${s.expires_at.toISOString()}.`,
        ...(nonReturnable ? ['Items marked non-returnable (personalised or food) cannot be returned.'] : []),
        'A person confirms the delivery address and payment method on the checkout page.',
      ],
      orderId: s.order_id,
    };
  }
}
