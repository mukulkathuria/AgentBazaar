import type {
  CartView,
  CheckoutLink,
  CheckoutSessionView,
  NegotiationOutcome,
  OrderView,
} from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const MUG = {
  sku: 'MITTI-MUG-WHITE',
  quantity: 1,
  customization: { text: { name: 'Asha', message: 'Pepsi lover' } },
};

describe('@lite checkout end to end', () => {
  let app: ShopApp;
  beforeAll(async () => {
    app = await createShopApp();
  });
  afterAll(async () => app.close());

  it('keeps a cart priced live from the catalog, with validated lines', async () => {
    const { cartId } = ok<CartView>(await call(app, 'POST', '/api/v1/carts'), 201);
    const url = `/api/v1/carts/${cartId}/lines`;
    ok(await call(app, 'POST', url, { body: { sku: 'thock-tk87-red', quantity: 2 } }), 200);
    let cart = ok<CartView>(await call(app, 'POST', url, { body: MUG }), 200);
    expect(cart.lines.map((l) => [l.sku, l.unitPricePaise, l.totalPaise, l.nonReturnable])).toEqual([
      ['THOCK-TK87-RED', 549_900, 1_099_800, false],
      ['MITTI-MUG-WHITE', 44_900 + 9900, 54_800, true],
    ]);
    expect(cart.subtotalPaise).toBe(1_154_600);

    const line = cart.lines[0]!.lineId;
    cart = ok<CartView>(await call(app, 'PATCH', `${url}/${line}`, { body: { quantity: 1 } }), 200);
    expect(cart.subtotalPaise).toBe(549_900 + 54_800);
    cart = ok<CartView>(await call(app, 'DELETE', `${url}/${line}`), 200);
    expect(cart.lines).toHaveLength(1);

    expect((await call(app, 'POST', url, { body: { sku: 'NO-SUCH-SKU', quantity: 1 } })).statusCode).toBe(
      404,
    );
    const rejected = await call(app, 'POST', url, {
      body: { ...MUG, customization: { text: { name: '<script>' } } },
    });
    expect(rejected.statusCode).toBe(400);
    expect((await call(app, 'POST', url, { body: { sku: 'THOCK-TK87-RED', quantity: 0 } })).statusCode).toBe(
      400,
    );
    expect((await call(app, 'GET', '/api/v1/carts/00000000-0000-4000-8000-000000000000')).statusCode).toBe(
      404,
    );
  });

  it('online: cart -> checkout -> pay -> paid, with a GST invoice and the stock taken', async () => {
    const before = await stockOf(app, 'THOCK-TK87-RED');
    const { session, order } = await buy(app, { sku: 'THOCK-TK87-RED', quantity: 2 });
    expect(session).toMatchObject({
      status: 'open',
      source: 'cart',
      subtotalPaise: 1_099_800,
      orderId: null,
    });
    expect(session.token).toEqual(expect.any(String));
    expect(order).toMatchObject({
      status: 'pending_payment',
      paymentMethod: 'online',
      totalPaise: 1_099_800,
      placeOfSupply: 'DL',
    });
    expect(order.number).toMatch(/^AB-\d+$/);
    expect(order.accessToken).toEqual(expect.any(String));
    expect(order.paymentUrl).toMatch(/^http:\/\/web\.test\/pay\/mock\//);
    // Prices include GST: taxable + tax = total, split CGST/SGST inside Delhi.
    expect(order.subtotalPaise + order.taxPaise).toBe(order.totalPaise);
    expect(order.lines[0]!.taxes.map((t) => [t.kind, t.rateBps])).toEqual([
      ['CGST', 900],
      ['SGST', 900],
    ]);
    expect(await stockOf(app, 'THOCK-TK87-RED')).toEqual({
      on_hand: before.on_hand,
      reserved: before.reserved + 2,
    });

    await pay(app, order);
    const paid = await getOrder(app, order);
    expect(paid.status).toBe('paid');
    expect(paid.invoiceNumber).toMatch(/^INV\/2026-27\/\d{6}$/);
    expect(paid.paymentUrl).toBeNull();
    expect(paid.timeline.map((t) => t.status)).toEqual(['pending_payment', 'paid']);
    expect(await stockOf(app, 'THOCK-TK87-RED')).toEqual({
      on_hand: before.on_hand - 2,
      reserved: before.reserved,
    });
    expect(await paymentStatus(app, order.orderId)).toBe('captured');
    // The session is spent and the cart emptied.
    const s = ok<CheckoutSessionView>(
      await call(app, 'GET', `/api/v1/checkout/sessions/${session.sessionId}?t=${session.token}`),
      200,
    );
    expect(s).toMatchObject({ status: 'completed', orderId: order.orderId });
  });

  it('cash on delivery: confirmed at once, stock committed, cash collected on delivery', async () => {
    const before = await stockOf(app, 'VOLTEDGE-850G');
    const { order } = await buy(app, { sku: 'VOLTEDGE-850G', quantity: 1 }, { method: 'cod' });
    expect(order).toMatchObject({ status: 'cod_confirmed', paymentMethod: 'cod', paymentUrl: null });
    expect(await stockOf(app, 'VOLTEDGE-850G')).toEqual({
      on_hand: before.on_hand - 1,
      reserved: before.reserved,
    });
    expect(await paymentStatus(app, order.orderId)).toBe('cod_pending');

    const admin = await adminToken(app);
    const shipped = ok<OrderView>(
      await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/ship`, {
        token: admin,
        body: { trackingNumber: 'DLV123456' },
      }),
      200,
    );
    expect(shipped).toMatchObject({ status: 'shipped', trackingNumber: 'DLV123456' });
    const delivered = ok<OrderView>(
      await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/deliver`, { token: admin }),
      200,
    );
    expect(delivered.status).toBe('delivered');
    expect(await paymentStatus(app, order.orderId)).toBe('cod_collected');
    expect(delivered.timeline.map((t) => t.status)).toEqual(['cod_confirmed', 'shipped', 'delivered']);
  });

  it('locks prices for the session: a catalog change mid-checkout does not move them', async () => {
    const cartId = await newCart(app, [{ sku: 'CUBIX-AIRFLOW-BLK', quantity: 1 }]);
    const session = await startCheckout(app, { cartId });
    expect(session.lines[0]!.unitPricePaise).toBe(499_900);
    await app.infra.database.query(
      `UPDATE variants SET price_paise = 529900, mrp_paise = 600000 WHERE sku = 'CUBIX-AIRFLOW-BLK'`,
    );
    const order = ok<OrderView>(await completeCheckout(app, session), 201);
    expect(order.lines[0]!.unitPricePaise).toBe(499_900);
    const fresh = ok<CartView>(
      await call(
        app,
        'GET',
        `/api/v1/carts/${await newCart(app, [{ sku: 'CUBIX-AIRFLOW-BLK', quantity: 1 }])}`,
      ),
      200,
    );
    expect(fresh.lines[0]!.unitPricePaise).toBe(529_900);
  });

  it('negotiated quote -> checkout -> order at the negotiated price', async () => {
    const { accessToken } = await registerCustomer(app);
    const opened = ok<NegotiationOutcome>(
      await call(app, 'POST', '/api/v1/quotes', {
        token: accessToken,
        body: { sku: 'THOCK-TK87-BROWN', quantity: 1 },
      }),
      201,
    );
    const countered = ok<NegotiationOutcome>(
      await call(app, 'POST', `/api/v1/negotiations/${opened.negotiationId}/offers`, {
        token: accessToken,
        body: { unitPricePaise: 500_000 },
      }),
      200,
    );
    const quote = countered.quote!;
    expect(quote.unitPricePaise).toBeLessThan(549_900);

    const session = await startCheckout(app, { quoteToken: quote.token }, accessToken);
    expect(session).toMatchObject({ source: 'quote', subtotalPaise: quote.totalPaise });
    const link = ok<CheckoutLink>(
      await call(app, 'POST', `/api/v1/checkout/sessions/${session.sessionId}/link?t=${session.token}`),
      200,
    );
    expect(link).toEqual({
      sessionId: session.sessionId,
      url: `http://web.test/checkout/${session.sessionId}?t=${session.token}`,
      expiresAt: session.expiresAt,
      amountPaise: quote.totalPaise,
      currency: 'INR',
    });

    const order = ok<OrderView>(await completeCheckout(app, session, {}, { token: accessToken }), 201);
    expect(order.lines[0]!.unitPricePaise).toBe(quote.unitPricePaise);
    // The customer sees it under their orders without the guest token.
    const mine = ok<OrderView[]>(await call(app, 'GET', '/api/v1/me/orders', { token: accessToken }), 200);
    expect(mine.map((o) => o.orderId)).toContain(order.orderId);
  });

  it('personalised items carry the surcharge, are non-returnable and queue flagged text for review', async () => {
    const { order } = await buy(app, MUG);
    expect(order.lines[0]).toMatchObject({
      unitPricePaise: 54_800,
      nonReturnable: true,
      customization: { text: { name: 'Asha', message: 'Pepsi lover' } },
    });
    const reviews = ok<{ sku: string; text: string; flags: string[] }[]>(
      await call(app, 'GET', '/api/v1/admin/reviews', { token: await adminToken(app) }),
      200,
    );
    expect(reviews).toContainEqual(
      expect.objectContaining({ sku: 'MITTI-MUG-WHITE', text: 'Pepsi lover', flags: ['trademark'] }),
    );
  });

  it('keeps the order when the gateway is down: no payment link, and the order still stands', async () => {
    const payments = app.app.get((await import('../../src/modules/payments/index.js')).PaymentsService);
    const real = payments.port.createPayment.bind(payments.port);
    payments.port.createPayment = () => Promise.reject(new Error('gateway timeout'));
    try {
      const { order } = await buy(app, { sku: 'KOKOA-MINI-13G', quantity: 3 });
      expect(order).toMatchObject({ status: 'pending_payment', paymentUrl: null });
      expect((await getOrder(app, order)).number).toBe(order.number);
    } finally {
      payments.port.createPayment = real;
    }
  });
});
