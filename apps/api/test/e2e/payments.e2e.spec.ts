import type { OrderView, PaymentView } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type MockPaymentAdapter, PaymentsService } from '../../src/modules/payments/index.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import {
  buy,
  call,
  createShopApp,
  getOrder,
  ok,
  pay,
  paymentIdOf,
  paymentStatus,
  stockOf,
  type ShopApp,
} from '../support/shop.js';

describe('@lite payments drive the order', () => {
  let app: ShopApp;
  let clock: ManualClock;
  let gateway: MockPaymentAdapter;
  const sweepHolds = () => app.infra.scheduler.runOnce('inventory.expire-reservations');

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
    gateway = app.app.get(PaymentsService).port as MockPaymentAdapter;
  });
  afterAll(async () => app.close());

  async function webhook(order: OrderView, kind: 'captured' | 'failed') {
    const [p] = await app.infra.database.query<{ provider_order_id: string; amount_paise: number }>(
      'SELECT provider_order_id, amount_paise FROM payments WHERE order_id = $1',
      [order.orderId],
    );
    const ev = gateway.signedEvent({
      kind,
      providerOrderId: p!.provider_order_id,
      amountPaise: p!.amount_paise,
    });
    return app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/mock',
      headers: { ...ev.headers, 'content-type': 'application/json' },
      payload: ev.raw,
    });
  }

  it('a signed gateway webhook marks the order paid; the payment page shows it with its own token', async () => {
    const { order } = await buy(app, { sku: 'VOLTEDGE-1000P', quantity: 1 });
    const res = await webhook(order, 'captured');
    expect(ok(res, 200)).toEqual({ received: true, result: 'applied' });
    await app.drain();
    expect((await getOrder(app, order)).status).toBe('paid');

    const token = new URL(order.paymentUrl!).searchParams.get('t')!;
    const payment = ok<PaymentView>(
      await call(app, 'GET', `/api/v1/payments/${paymentIdOf(order)}?t=${encodeURIComponent(token)}`),
      200,
    );
    expect(payment).toMatchObject({
      status: 'captured',
      amountPaise: order.totalPaise,
      orderId: order.orderId,
    });
  });

  it('re-reserves stock when the hold lapsed before the money arrived', async () => {
    const sku = 'THOCK-TK87-BROWN';
    const before = await stockOf(app, sku);
    const { order } = await buy(app, { sku, quantity: 2 });
    clock.advance(31 * 60_000);
    expect(await sweepHolds()).toBeGreaterThan(0);
    expect(await stockOf(app, sku)).toEqual(before);

    await pay(app, order);
    expect((await getOrder(app, order)).status).toBe('paid');
    expect(await stockOf(app, sku)).toEqual({ on_hand: before.on_hand - 2, reserved: before.reserved });
  });

  it('cancels and refunds in full when the stock sold out while the hold was lapsed', async () => {
    const sku = 'ZENTRIX-ZX9090TI-24G';
    const before = await stockOf(app, sku);
    const late = await buy(app, { sku, quantity: before.on_hand });
    clock.advance(31 * 60_000);
    await sweepHolds();
    const other = await buy(app, { sku, quantity: before.on_hand }); // someone else takes every unit

    await pay(app, late.order);
    const cancelled = await getOrder(app, late.order);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.timeline.at(-1)!.note).toMatch(/sold out/);
    await vi.waitFor(async () => expect(await paymentStatus(app, late.order.orderId)).toBe('refunded'));
    // The other buyer's hold is untouched and nothing was oversold.
    expect(await stockOf(app, sku)).toEqual({ on_hand: before.on_hand, reserved: before.on_hand });
    expect((await getOrder(app, other.order)).status).toBe('pending_payment');
  });

  it('refunds money that arrives after the buyer cancelled', async () => {
    const { order } = await buy(app, { sku: 'CUBIX-AIRFLOW-BLK', quantity: 1 });
    ok(await call(app, 'POST', `/api/v1/orders/${order.orderId}/cancel?t=${order.accessToken}`), 200);
    await pay(app, order);
    await vi.waitFor(async () => expect(await paymentStatus(app, order.orderId)).toBe('refunded'));
    expect((await getOrder(app, order)).status).toBe('cancelled');
    const audit = await app.infra.database.query<{ target: string }>(
      `SELECT target FROM audit_log WHERE action = 'payment.after_close'`,
    );
    expect(audit.map((a) => a.target)).toContain(order.orderId);
  });
});
