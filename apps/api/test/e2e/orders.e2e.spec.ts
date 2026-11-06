import type { CheckoutSessionView, OrderView } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import {
  adminToken,
  buy,
  call,
  completeCheckout,
  createShopApp,
  getOrder,
  newCart,
  ok,
  pay,
  paymentStatus,
  registerCustomer,
  startCheckout,
  stockOf,
  type ShopApp,
} from '../support/shop.js';

const KEYBOARD = 'THOCK-TK87-BLUE';

async function shipAndDeliver(app: ShopApp, admin: string, orderId: string): Promise<OrderView> {
  ok(
    await call(app, 'POST', `/api/v1/admin/orders/${orderId}/ship`, {
      token: admin,
      body: { trackingNumber: 'TRK-0001' },
    }),
    200,
  );
  return ok<OrderView>(
    await call(app, 'POST', `/api/v1/admin/orders/${orderId}/deliver`, { token: admin }),
    200,
  );
}

describe('@lite orders: access, cancellation, returns and fulfilment', () => {
  let app: ShopApp;
  let admin: string;
  beforeAll(async () => {
    app = await createShopApp();
    admin = await adminToken(app);
  });
  afterAll(async () => app.close());

  it('lets a guest read the order with its token and a customer list their own orders', async () => {
    const guest = await buy(app, { sku: 'KOKOA-MINI-13G', quantity: 2 });
    expect((await getOrder(app, guest.order)).orderId).toBe(guest.order.orderId);
    expect((await getOrder(app, guest.order)).accessToken).toBeUndefined();

    const { accessToken } = await registerCustomer(app);
    const mine = await buy(app, { sku: 'KOKOA-MINI-13G', quantity: 1 }, { token: accessToken });
    const listed = ok<OrderView[]>(await call(app, 'GET', '/api/v1/me/orders', { token: accessToken }), 200);
    expect(listed.map((o) => o.orderId)).toEqual([mine.order.orderId]);
    expect(
      ok<OrderView>(
        await call(app, 'GET', `/api/v1/orders/${mine.order.orderId}`, { token: accessToken }),
        200,
      ).number,
    ).toBe(mine.order.number);
  });

  it('cancels an unpaid order and gives the held stock back', async () => {
    const before = await stockOf(app, KEYBOARD);
    const { order } = await buy(app, { sku: KEYBOARD, quantity: 1 });
    expect((await stockOf(app, KEYBOARD)).reserved).toBe(before.reserved + 1);
    const cancelled = ok<OrderView>(
      await call(app, 'POST', `/api/v1/orders/${order.orderId}/cancel?t=${order.accessToken}`),
      200,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(await stockOf(app, KEYBOARD)).toEqual(before);
  });

  it('cancels a paid order: restocks and refunds in full', async () => {
    const before = await stockOf(app, KEYBOARD);
    const { order } = await buy(app, { sku: KEYBOARD, quantity: 1 });
    await pay(app, order);
    expect((await stockOf(app, KEYBOARD)).on_hand).toBe(before.on_hand - 1);
    const cancelled = ok<OrderView>(
      await call(app, 'POST', `/api/v1/orders/${order.orderId}/cancel?t=${order.accessToken}`),
      200,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(await stockOf(app, KEYBOARD)).toEqual(before);
    expect(await paymentStatus(app, order.orderId)).toBe('refunded');
    await app.drain(); // the refund event changes nothing on a cancelled order
    expect((await getOrder(app, order)).status).toBe('cancelled');
  });

  it('refuses to cancel once shipped, and ships only paid or COD orders', async () => {
    const unpaid = await buy(app, { sku: KEYBOARD, quantity: 1 });
    const early = await call(app, 'POST', `/api/v1/admin/orders/${unpaid.order.orderId}/ship`, {
      token: admin,
      body: { trackingNumber: 'TRK-0002' },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: { code: 'illegal_transition' } });

    const { order } = await buy(app, { sku: KEYBOARD, quantity: 1 });
    await pay(app, order);
    ok(
      await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/ship`, {
        token: admin,
        body: { trackingNumber: 'TRK-0003' },
      }),
      200,
    );
    const late = await call(app, 'POST', `/api/v1/orders/${order.orderId}/cancel?t=${order.accessToken}`);
    expect(late.statusCode).toBe(409);
  });

  it('returns within the window: request, receive, restock, refund', async () => {
    const before = await stockOf(app, KEYBOARD);
    const { order } = await buy(app, { sku: KEYBOARD, quantity: 1 });
    await pay(app, order);
    await shipAndDeliver(app, admin, order.orderId);

    const early = await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/returns/complete`, {
      token: admin,
    });
    expect(early.statusCode).toBe(409);
    const requested = ok<OrderView>(
      await call(app, 'POST', `/api/v1/orders/${order.orderId}/returns?t=${order.accessToken}`, {
        body: { reason: 'damaged', note: 'Box crushed' },
      }),
      200,
    );
    expect(requested.status).toBe('return_requested');
    const returned = ok<OrderView>(
      await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/returns/complete`, { token: admin }),
      200,
    );
    expect(returned.status).toBe('returned');
    expect(await stockOf(app, KEYBOARD)).toEqual(before);
    expect(await paymentStatus(app, order.orderId)).toBe('refunded');

    await app.drain();
    const refunded = await getOrder(app, order);
    expect(refunded.status).toBe('refunded');
    expect(refunded.timeline.map((t) => t.status)).toEqual([
      'pending_payment',
      'paid',
      'shipped',
      'delivered',
      'return_requested',
      'returned',
      'refunded',
    ]);
    const [rr] = await app.infra.database.query<{ status: string }>(
      'SELECT status FROM return_requests WHERE order_id = $1',
      [order.orderId],
    );
    expect(rr!.status).toBe('refunded');
  });

  it('refuses returns after the window, before delivery, and for personalised or food items', async () => {
    const { order } = await buy(app, { sku: KEYBOARD, quantity: 1 });
    await pay(app, order);
    const ret = (o: OrderView) =>
      call(app, 'POST', `/api/v1/orders/${o.orderId}/returns?t=${o.accessToken}`, {
        body: { reason: 'changed_mind' },
      });
    expect((await ret(order)).statusCode).toBe(409); // paid, not delivered
    await shipAndDeliver(app, admin, order.orderId);
    await app.infra.database.query(
      `UPDATE orders SET delivered_at = now() - interval '8 days' WHERE id = $1`,
      [order.orderId],
    );
    const late = await ret(order);
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: { message: string } }>().error.message).toMatch(/return window closed/);

    for (const line of [
      { sku: 'MITTI-MUG-BLACK', quantity: 1, customization: { text: { name: 'Ravi' } } },
      { sku: 'KOKOA-MINI-13G-X10', quantity: 1 },
    ]) {
      const { order: o } = await buy(app, line, { method: 'cod' });
      await shipAndDeliver(app, admin, o.orderId);
      const r = await ret(o);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: { code: 'conflict', details: { skus: [line.sku] } } });
    }
  });
});

describe('@lite orders: expiry jobs and UPI reconciliation', () => {
  let app: ShopApp;
  let clock: ManualClock;
  const sku = 'ZENTRIX-ZX7070-12G';
  const run = (job: string) => app.infra.scheduler.runOnce(job);
  const paymentEvent = (orderId: string, status: string) =>
    app.infra.database.query(
      `INSERT INTO outbox_events (topic, aggregate_id, payload) VALUES ('payment.status_changed', $1, $2::jsonb)`,
      [orderId, JSON.stringify({ paymentId: '00000000-0000-4000-8000-000000000000', orderId, status })],
    );

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
  });
  afterAll(async () => app.close());

  it('expires an abandoned checkout and releases its stock', async () => {
    const before = await stockOf(app, sku);
    const session: CheckoutSessionView = await startCheckout(app, {
      cartId: await newCart(app, [{ sku, quantity: 2 }]),
    });
    expect((await stockOf(app, sku)).reserved).toBe(before.reserved + 2);
    clock.advance(31 * 60_000);
    expect(await run('orders.expire-checkouts')).toBe(1);
    expect(await stockOf(app, sku)).toEqual(before);
    const s = await call(app, 'GET', `/api/v1/checkout/sessions/${session.sessionId}?t=${session.token}`);
    expect(s.statusCode).toBe(409); // the capability expired with the session
  });

  it('expires an unpaid order, and refunds a payment that arrives after it closed', async () => {
    const before = await stockOf(app, sku);
    const { order } = await buy(app, { sku, quantity: 1 });
    clock.advance(31 * 60_000);
    expect(await run('orders.expire-unpaid')).toBe(1);
    expect(await stockOf(app, sku)).toEqual(before);
    expect((await getOrder(app, order)).status).toBe('expired');

    await pay(app, order);
    await vi.waitFor(async () => expect(await paymentStatus(app, order.orderId)).toBe('refunded'));
    expect((await getOrder(app, order)).status).toBe('expired');
  });

  it('holds UPI orders in payment_observed until reconciled, and ships nothing before that', async () => {
    const { order } = await buy(app, { sku, quantity: 1 });
    await paymentEvent(order.orderId, 'observed');
    await app.drain();
    expect((await getOrder(app, order)).status).toBe('payment_observed');
    // Long after the normal 30-minute hold, the stock is still held for the UPI order.
    clock.advance(2 * 3600_000);
    await run('inventory.expire-reservations');
    await run('orders.expire-unpaid');
    expect((await getOrder(app, order)).status).toBe('payment_observed');
    const ship = await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/ship`, {
      token: await adminToken(app),
      body: { trackingNumber: 'TRK-UPI-1' },
    });
    expect(ship.statusCode).toBe(409);

    await paymentEvent(order.orderId, 'reconciled');
    await app.drain();
    const paid = await getOrder(app, order);
    expect(paid.status).toBe('paid');
    expect(paid.invoiceNumber).toMatch(/^INV\/2026-27\//);
  });

  it('cancels UPI payments left unreconciled for 72 hours and flags them for a person', async () => {
    const before = await stockOf(app, sku);
    const { order } = await buy(app, { sku, quantity: 1 });
    await paymentEvent(order.orderId, 'observed');
    await app.drain();
    clock.advance(73 * 3600_000);
    expect(await run('orders.cancel-unreconciled')).toBe(1);
    expect((await getOrder(app, order)).status).toBe('cancelled');
    expect(await stockOf(app, sku)).toEqual(before);
    const audit = await app.infra.database.query<{ target: string }>(
      `SELECT target FROM audit_log WHERE action = 'payment.unreconciled'`,
    );
    expect(audit.map((a) => a.target)).toContain(order.orderId);
  });

  it('a failed payment can be retried until the window closes', async () => {
    const { order } = await buy(app, { sku, quantity: 1 });
    await pay(app, order, 'failure');
    const failed = await getOrder(app, order);
    expect(failed.status).toBe('payment_failed');
    expect(failed.paymentUrl).toBe(order.paymentUrl);
    await pay(app, order, 'success');
    expect((await getOrder(app, order)).status).toBe('paid');
  });

  it('completing an expired session is refused', async () => {
    const session = await startCheckout(app, {
      cartId: await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 1 }]),
    });
    clock.advance(31 * 60_000);
    const res = await completeCheckout(app, session);
    expect(res.statusCode).toBe(409);
  });
});
