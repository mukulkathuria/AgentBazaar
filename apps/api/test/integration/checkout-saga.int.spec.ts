import { Writable } from 'node:stream';
import type { CompleteCheckoutInput } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CheckoutActivities,
  CheckoutSagaInput,
} from '../../src/modules/orders/application/checkout-saga.js';
import { OrderPlacement } from '../../src/modules/orders/application/order-placement.js';
import { CheckoutSagaSteps } from '../../src/modules/orders/index.js';
import { PaymentsService } from '../../src/modules/payments/index.js';
import { sha256Hex } from '../../src/shared/crypto/primitives.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import {
  ADDRESS,
  BUYER_EMAIL,
  createShopApp,
  newCart,
  startCheckout,
  stockOf,
  type ShopApp,
} from '../support/shop.js';

/*
 * The saga's steps run twice each, as a Temporal retry or replay would run them: every effect still
 * happens once. No Temporal needed; test/services/sagas.spec.ts runs the real workflow with crashes.
 */
describe('@scale checkout saga steps are idempotent', () => {
  const SKU = 'VOLTEDGE-1000P';
  const logs: string[] = [];
  let app: ShopApp;
  let steps: CheckoutActivities;

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    app = await createShopApp({ logger: createLogger('info', sink) });
    steps = app.app.get(CheckoutSagaSteps).activities;
  });
  afterAll(async () => app.close());

  const count = async (sql: string, params: unknown[]) =>
    (await app.infra.database.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params))[0]!.n;
  const orderOf = async (id: string) =>
    (
      await app.infra.database.query<{ status: string; invoice_number: string | null; number: string }>(
        'SELECT status, invoice_number, number FROM orders WHERE id = $1',
        [id],
      )
    )[0]!;
  const paidEmails = (number: string) =>
    logs.filter(
      (l) =>
        l.includes('"msg":"order email"') &&
        l.includes('"template":"order.paid"') &&
        l.includes(`"${number}"`),
    ).length;

  async function sagaInput(
    paymentMethod: CompleteCheckoutInput['paymentMethod'] = 'online',
  ): Promise<CheckoutSagaInput> {
    const session = await startCheckout(app, { cartId: await newCart(app, [{ sku: SKU, quantity: 2 }]) });
    const buyer = await inTransaction(app.infra.db, (tx) =>
      app.app
        .get(OrderPlacement)
        .vaultBuyer(tx, { email: BUYER_EMAIL, address: ADDRESS, paymentMethod, acceptTerms: true }),
    );
    return { sessionId: session.sessionId, buyer, accessTokenHash: sha256Hex(`token-${session.sessionId}`) };
  }

  /** What the gateway's webhook does, without the outbox consumer that would settle the order in-process. */
  async function capture(orderId: string): Promise<void> {
    const [p] = await app.infra.database.query<{ id: string }>(
      'SELECT id FROM payments WHERE order_id = $1',
      [orderId],
    );
    expect(await app.app.get(PaymentsService).mockComplete(p!.id, 'success')).toBe('applied');
  }

  async function placeAndCapture(): Promise<{ input: CheckoutSagaInput; orderId: string }> {
    const input = await sagaInput();
    await steps.reserveStock(input.sessionId);
    const { orderId } = await steps.createOrder(input);
    await steps.createPayment(orderId);
    await capture(orderId);
    return { input, orderId };
  }

  it('places, opens the payment, commits stock, invoices and notifies once when every step runs twice', async () => {
    const before = await stockOf(app, SKU);
    const input = await sagaInput();
    await steps.reserveStock(input.sessionId);
    await steps.reserveStock(input.sessionId);
    const placed = await steps.createOrder(input);
    expect(await steps.createOrder(input)).toEqual(placed);
    await steps.createPayment(placed.orderId);
    await steps.createPayment(placed.orderId);
    expect(
      await count('payments WHERE order_id = $1 AND provider_order_id IS NOT NULL', [placed.orderId]),
    ).toBe(1);
    expect(await steps.paymentState(placed.orderId)).toMatchObject({ state: 'awaiting' });

    await capture(placed.orderId);
    expect(await steps.paymentState(placed.orderId)).toEqual({ state: 'settled' });
    expect(await steps.commitStock(placed.orderId)).toBe('committed');
    expect(await steps.commitStock(placed.orderId)).toBe('committed');
    await steps.issueInvoice(placed.orderId);
    await steps.issueInvoice(placed.orderId);
    await steps.notify(placed.orderId);
    await steps.notify(placed.orderId);
    await app.drain(); // the relay now delivers order.paid too; the email consumer has already sent it

    const order = await orderOf(placed.orderId);
    expect(order.status).toBe('paid');
    expect(order.invoice_number).toMatch(/^INV\//);
    expect(await count('invoices WHERE order_id = $1', [placed.orderId])).toBe(1);
    expect(await count(`order_events WHERE order_id = $1 AND to_status = 'paid'`, [placed.orderId])).toBe(1);
    expect(
      await count(`reservations WHERE owner_ref = $1 AND status = 'committed'`, [`order:${placed.orderId}`]),
    ).toBe(1);
    expect(await stockOf(app, SKU)).toEqual({ on_hand: before.on_hand - 2, reserved: before.reserved });
    expect(paidEmails(order.number)).toBe(1);
  });

  it('compensates an unpaid order once: expired, stock back, nothing to refund', async () => {
    const before = await stockOf(app, SKU);
    const input = await sagaInput();
    await steps.reserveStock(input.sessionId);
    const { orderId } = await steps.createOrder(input);
    expect(await steps.abandon(input.sessionId, 'expired')).toBe(orderId);
    expect(await steps.abandon(input.sessionId, 'expired')).toBe(orderId);
    await steps.refund(orderId, 'payment_after_close');
    expect((await orderOf(orderId)).status).toBe('expired');
    expect(await count(`order_events WHERE order_id = $1 AND to_status = 'expired'`, [orderId])).toBe(1);
    expect(
      await count('refunds r JOIN payments p ON p.id = r.payment_id WHERE p.order_id = $1', [orderId]),
    ).toBe(0);
    expect(await stockOf(app, SKU)).toEqual(before);
    expect(await steps.paymentState(orderId)).toEqual({ state: 'closed' });
  });

  it('refunds money that reached a cancelled order exactly once', async () => {
    const before = await stockOf(app, SKU);
    const { input, orderId } = await placeAndCapture();
    expect(await steps.abandon(input.sessionId, 'cancelled')).toBe(orderId);
    await steps.refund(orderId, 'payment_after_close');
    await steps.refund(orderId, 'payment_after_close');
    expect(await steps.commitStock(orderId)).toBe('closed');
    await app.drain(); // the in-process consumer sees money after close: its refund is the same one
    expect((await orderOf(orderId)).status).toBe('cancelled');
    expect(
      await count('refunds r JOIN payments p ON p.id = r.payment_id WHERE p.order_id = $1', [orderId]),
    ).toBe(1);
    expect(await stockOf(app, SKU)).toEqual(before);
  });

  it('leaves a paid order alone when a late cancel compensates', async () => {
    const { input, orderId } = await placeAndCapture();
    expect(await steps.commitStock(orderId)).toBe('committed');
    expect(await steps.abandon(input.sessionId, 'cancelled')).toBeNull();
    expect((await orderOf(orderId)).status).toBe('paid');
  });

  it('refuses an expired checkout without retrying: the step fails with the API error', async () => {
    const input = await sagaInput();
    await app.infra.database.query(
      `UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [input.sessionId],
    );
    await expect(steps.reserveStock(input.sessionId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(steps.createOrder(input)).rejects.toMatchObject({ code: 'conflict' });
    expect(await steps.abandon(input.sessionId, 'cancelled')).toBeNull();
  });

  it('places a cash-on-delivery order with its stock committed and no gateway payment', async () => {
    const before = await stockOf(app, SKU);
    const input = await sagaInput('cod');
    await steps.reserveStock(input.sessionId);
    const placed = await steps.createOrder(input);
    expect(placed.method).toBe('cod');
    expect((await orderOf(placed.orderId)).status).toBe('cod_confirmed');
    expect(await stockOf(app, SKU)).toEqual({ on_hand: before.on_hand - 2, reserved: before.reserved });
  });
});
