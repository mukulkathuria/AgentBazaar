import type { OrderView } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockPaymentAdapter, PaymentsService } from '../../src/modules/payments/index.js';
import { buy, createShopApp, getOrder, paymentStatus, stockOf, type ShopApp } from '../support/shop.js';

describe('@lite negative: webhooks cannot be replayed, reordered, underpaid or forged', () => {
  let app: ShopApp;
  let gateway: MockPaymentAdapter;
  beforeAll(async () => {
    app = await createShopApp();
    gateway = app.app.get(PaymentsService).port as MockPaymentAdapter;
  });
  afterAll(async () => app.close());

  async function eventFor(order: OrderView, kind: 'captured' | 'failed', amountPaise?: number) {
    const [p] = await app.infra.database.query<{ provider_order_id: string; amount_paise: number }>(
      'SELECT provider_order_id, amount_paise FROM payments WHERE order_id = $1',
      [order.orderId],
    );
    return gateway.signedEvent({
      kind,
      providerOrderId: p!.provider_order_id,
      amountPaise: amountPaise ?? p!.amount_paise,
    });
  }
  const send = (ev: { raw: Buffer; headers: Record<string, string> }) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/mock',
      headers: { ...ev.headers, 'content-type': 'application/json' },
      payload: ev.raw,
    });
  const statusEvents = async (orderId: string) =>
    (
      await app.infra.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'payment.status_changed' AND aggregate_id = $1`,
        [orderId],
      )
    )[0]!.n;

  it('applies a replayed webhook once', async () => {
    const { order } = await buy(app, { sku: 'THOCK-TK87-RED', quantity: 1 });
    const ev = await eventFor(order, 'captured');
    expect((await send(ev)).json()).toEqual({ received: true, result: 'applied' });
    await app.drain();
    const stock = await stockOf(app, 'THOCK-TK87-RED');
    expect((await send(ev)).json()).toEqual({ received: true, result: 'duplicate' });
    await app.drain();
    expect(await statusEvents(order.orderId)).toBe(1);
    expect(await stockOf(app, 'THOCK-TK87-RED')).toEqual(stock);
    const paid = await getOrder(app, order);
    expect(paid.status).toBe('paid');
    expect(paid.timeline.filter((t) => t.status === 'paid')).toHaveLength(1);
  });

  it('ignores a failure that arrives after the capture (out of order)', async () => {
    const { order } = await buy(app, { sku: 'THOCK-TK87-RED', quantity: 1 });
    await send(await eventFor(order, 'captured'));
    await app.drain();
    expect((await send(await eventFor(order, 'failed'))).json()).toEqual({ received: true, result: 'stale' });
    await app.drain();
    expect((await getOrder(app, order)).status).toBe('paid');
    expect(await paymentStatus(app, order.orderId)).toBe('captured');
  });

  it('refuses an underpayment: 409, and the order is not paid', async () => {
    const { order } = await buy(app, { sku: 'THOCK-TK87-RED', quantity: 1 });
    const res = await send(await eventFor(order, 'captured', order.totalPaise - 100));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ received: true, result: 'amount_mismatch' });
    await app.drain();
    expect((await getOrder(app, order)).status).toBe('pending_payment');
    expect(await paymentStatus(app, order.orderId)).toBe('created');
  });

  it('rejects a bad signature or a body changed after signing', async () => {
    const { order } = await buy(app, { sku: 'THOCK-TK87-RED', quantity: 1 });
    const ev = await eventFor(order, 'captured');
    const forged = await send({ raw: ev.raw, headers: { 'x-mock-signature': 'f'.repeat(64) } });
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ error: { code: 'invalid_signature' } });
    const edited = Buffer.from(ev.raw.toString().replace(`"amount":${order.totalPaise}`, '"amount":1'));
    expect((await send({ raw: edited, headers: ev.headers })).statusCode).toBe(401);
    expect((await send({ raw: ev.raw, headers: {} })).statusCode).toBe(401);
    const otherProvider = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/razorpay',
      headers: { ...ev.headers, 'content-type': 'application/json' },
      payload: ev.raw,
    });
    expect(otherProvider.statusCode).toBe(404);
    await app.drain();
    expect((await getOrder(app, order)).status).toBe('pending_payment');
  });
});
