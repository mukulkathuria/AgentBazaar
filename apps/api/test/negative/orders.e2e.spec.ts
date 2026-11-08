import type { CartView, CheckoutSessionView, NegotiationOutcome, OrderView } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import {
  ADDRESS,
  adminToken,
  BUYER_EMAIL,
  buy,
  call,
  completeCheckout,
  createShopApp,
  idemKey,
  newCart,
  ok,
  registerCustomer,
  startCheckout,
  stockOf,
  type ShopApp,
} from '../support/shop.js';

/** Flips one character of the signed part, keeping the token well-formed. */
const tamper = (t: string) => {
  const [body, sig] = t.split('.') as [string, string];
  return `${body.slice(0, -2)}${body.at(-2) === 'A' ? 'B' : 'A'}${body.at(-1)}.${sig}`;
};

describe('@lite negative: quotes, checkout tokens, idempotency, IDOR and mass assignment', () => {
  let app: ShopApp;
  let clock: ManualClock;
  const startWith = (body: unknown, token?: string) =>
    call(app, 'POST', '/api/v1/checkout/sessions', {
      body,
      token,
      headers: { 'idempotency-key': idemKey() },
    });
  async function quoteFor(token: string, sku = 'VOLTEDGE-850G'): Promise<NegotiationOutcome> {
    return ok<NegotiationOutcome>(
      await call(app, 'POST', '/api/v1/quotes', { token, body: { sku, quantity: 1 } }),
      201,
    );
  }

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
  });
  afterAll(async () => app.close());

  it('rejects tampered, expired, reused and cross-customer quote tokens', async () => {
    const alice = await registerCustomer(app);
    const bob = await registerCustomer(app);
    const q = (await quoteFor(alice.accessToken)).quote!;

    const tampered = await startWith({ quoteToken: tamper(q.token) }, alice.accessToken);
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json()).toMatchObject({ error: { code: 'quote_invalid' } });
    const stolen = await startWith({ quoteToken: q.token }, bob.accessToken);
    expect(stolen.json()).toMatchObject({ error: { code: 'quote_invalid' } });
    const anonymous = await startWith({ quoteToken: q.token });
    expect(anonymous.json()).toMatchObject({ error: { code: 'quote_invalid' } });

    ok(await startWith({ quoteToken: q.token }, alice.accessToken), 201);
    const reused = await startWith({ quoteToken: q.token }, alice.accessToken);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: 'quote_used' } });

    const old = (await quoteFor(alice.accessToken)).quote!;
    clock.advance(16 * 60_000);
    // The 15-minute access token lapsed too; a refreshed session is still the same customer.
    const fresh = ok<{ accessToken: string }>(
      await call(app, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refreshToken } }),
      200,
    );
    const expired = await startWith({ quoteToken: old.token }, fresh.accessToken);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: { code: 'quote_expired' } });
  });

  it('keeps a quote usable when checkout fails for stock, and never reserves part of an order', async () => {
    const alice = await registerCustomer(app);
    const q = (await quoteFor(alice.accessToken, 'VOLTEDGE-1000P')).quote!;
    const before = await stockOf(app, 'VOLTEDGE-1000P');
    await app.infra.database.query(
      `UPDATE stock_levels SET reserved = on_hand WHERE variant_id = (SELECT id FROM variants WHERE sku = 'VOLTEDGE-1000P')`,
    );
    const sold = await startWith({ quoteToken: q.token }, alice.accessToken);
    expect(sold.statusCode).toBe(409);
    expect(sold.json()).toMatchObject({ error: { code: 'out_of_stock' } });
    await app.infra.database.query(
      `UPDATE stock_levels SET reserved = $1 WHERE variant_id = (SELECT id FROM variants WHERE sku = 'VOLTEDGE-1000P')`,
      [before.reserved],
    );
    ok(await startWith({ quoteToken: q.token }, alice.accessToken), 201);

    // Two lines, the second impossible: the first line must not stay reserved. One unit more than the GPU
    // stock keeps the cart under the ₹1 crore order ceiling, so checkout (not the cart) is what refuses it.
    const kb = await stockOf(app, 'THOCK-TK87-RED');
    const gpu = await stockOf(app, 'ZENTRIX-ZX9090TI-24G');
    const cartId = await newCart(app, [
      { sku: 'THOCK-TK87-RED', quantity: 1 },
      { sku: 'ZENTRIX-ZX9090TI-24G', quantity: gpu.on_hand - gpu.reserved + 1 },
    ]);
    expect((await startWith({ cartId })).statusCode).toBe(409);
    expect(await stockOf(app, 'THOCK-TK87-RED')).toEqual(kb);
  });

  it('refuses tampered or foreign checkout tokens', async () => {
    const a = await startCheckout(app, {
      cartId: await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 1 }]),
    });
    const b = await startCheckout(app, {
      cartId: await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 1 }]),
    });
    const get = (id: string, t: string) =>
      call(app, 'GET', `/api/v1/checkout/sessions/${id}?t=${encodeURIComponent(t)}`);
    expect((await get(a.sessionId, tamper(a.token!))).statusCode).toBe(404);
    expect((await get(a.sessionId, b.token!)).statusCode).toBe(404);
    expect((await get(a.sessionId, 'not-a-token')).statusCode).toBe(404);
    const q = (await quoteFor((await registerCustomer(app)).accessToken)).quote!;
    expect((await get(a.sessionId, q.token)).statusCode).toBe(404); // a quote token is not a checkout token
    expect(
      (await completeCheckout(app, { sessionId: a.sessionId, token: tamper(a.token!) })).statusCode,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/api/v1/checkout/sessions/${a.sessionId}/link?t=${b.token}`)).statusCode,
    ).toBe(404);
  });

  it('requires an Idempotency-Key, replays the same order, and refuses the key with a different body', async () => {
    const session = await startCheckout(app, {
      cartId: await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 2 }]),
    });
    const url = `/api/v1/checkout/sessions/${session.sessionId}/complete?t=${session.token}`;
    const body = { email: BUYER_EMAIL, address: ADDRESS, paymentMethod: 'online', acceptTerms: true };
    expect((await call(app, 'POST', url, { body })).statusCode).toBe(400);

    const key = idemKey();
    const first = ok<OrderView>(
      await call(app, 'POST', url, { body, headers: { 'idempotency-key': key } }),
      201,
    );
    const replay = ok<OrderView>(
      await call(app, 'POST', url, { body, headers: { 'idempotency-key': key } }),
      201,
    );
    expect(replay.orderId).toBe(first.orderId);
    expect(replay.number).toBe(first.number);
    const changed = await call(app, 'POST', url, {
      body: { ...body, paymentMethod: 'cod' },
      headers: { 'idempotency-key': key },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });
    // A fresh key on a completed session cannot create a second order.
    expect(
      (await call(app, 'POST', url, { body, headers: { 'idempotency-key': idemKey() } })).statusCode,
    ).toBe(409);
    const [n] = await app.infra.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM orders WHERE checkout_session_id = $1',
      [session.sessionId],
    );
    expect(n!.n).toBe(1);
  });

  it('creates exactly one order from a double submit', async () => {
    const session = await startCheckout(app, {
      cartId: await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 1 }]),
    });
    const key = idemKey();
    const results = await Promise.all([
      completeCheckout(app, session, {}, { key }),
      completeCheckout(app, session, {}, { key }),
      completeCheckout(app, session),
      completeCheckout(app, session),
    ]);
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toEqual([]);
    const ids = new Set(results.filter((r) => r.statusCode === 201).map((r) => r.json<OrderView>().orderId));
    expect(ids.size).toBe(1);
    const [n] = await app.infra.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM orders WHERE checkout_session_id = $1',
      [session.sessionId],
    );
    expect(n!.n).toBe(1);
  });

  it("hides other people's orders and carts (IDOR): wrong token, other customer, same-IP guest", async () => {
    const alice = await registerCustomer(app);
    const bob = await registerCustomer(app);
    const { order } = await buy(app, { sku: 'KOKOA-MINI-13G', quantity: 1 }, { token: alice.accessToken });
    const guest = await buy(app, { sku: 'KOKOA-MINI-13G', quantity: 1 });
    const read = (id: string, opts: { t?: string; token?: string } = {}) =>
      call(app, 'GET', `/api/v1/orders/${id}${opts.t ? `?t=${opts.t}` : ''}`, { token: opts.token });

    expect((await read(order.orderId, { token: alice.accessToken })).statusCode).toBe(200);
    expect((await read(order.orderId, { token: bob.accessToken })).statusCode).toBe(404);
    expect((await read(order.orderId, { t: 'wrong-token-1234567890' })).statusCode).toBe(404);
    expect((await read(order.orderId, { t: guest.order.accessToken! })).statusCode).toBe(404);
    // Guests share an IP hash; that never grants access without the order token.
    expect((await read(guest.order.orderId)).statusCode).toBe(404);
    expect(
      (await read('00000000-0000-4000-8000-000000000000', { token: alice.accessToken })).statusCode,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/api/v1/orders/${order.orderId}/cancel`, { token: bob.accessToken }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/api/v1/orders/${guest.order.orderId}/cancel?t=nope-nope-nope`)).statusCode,
    ).toBe(404);
    const mine = ok<OrderView[]>(
      await call(app, 'GET', '/api/v1/me/orders', { token: bob.accessToken }),
      200,
    );
    expect(mine).toEqual([]);

    const cartA = await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 1 }]);
    const cartB = ok<CartView>(
      await call(app, 'GET', `/api/v1/carts/${await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 1 }])}`),
      200,
    );
    const crossLine = await call(app, 'PATCH', `/api/v1/carts/${cartA}/lines/${cartB.lines[0]!.lineId}`, {
      body: { quantity: 5 },
    });
    expect(crossLine.statusCode).toBe(404);
  });

  it('rejects mass assignment: unknown fields never reach the services', async () => {
    const cartId = await newCart(app, [{ sku: 'KOKOA-MINI-13G', quantity: 1 }]);
    const session: CheckoutSessionView = await startCheckout(app, { cartId });
    const extra = [
      call(app, 'POST', `/api/v1/carts/${cartId}/lines`, {
        body: { sku: 'KOKOA-MINI-13G', quantity: 1, unitPricePaise: 1 },
      }),
      completeCheckout(app, session, { status: 'paid', totalPaise: 1 } as never),
      completeCheckout(app, session, { address: { ...ADDRESS, gstin: 'X' } } as never),
      startWith({ cartId, subtotalPaise: 1 }),
      call(app, 'POST', `/api/v1/orders/${session.sessionId}/returns`, {
        body: { reason: 'damaged', refundPaise: 999 },
      }),
      call(app, 'POST', '/api/v1/auth/register', {
        body: {
          email: 'x@example.com',
          password: 'Secret-pass-2026',
          name: 'X',
          consents: { terms: true },
          role: 'admin',
        },
      }),
    ];
    for (const res of await Promise.all(extra)) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'validation_failed' } });
    }
    const admin = await adminToken(app);
    const ship = await call(app, 'POST', `/api/v1/admin/orders/${session.sessionId}/ship`, {
      token: admin,
      body: { trackingNumber: 'TRK-1', status: 'delivered' },
    });
    expect(ship.statusCode).toBe(400);
    expect((await completeCheckout(app, session, { acceptTerms: false } as never)).statusCode).toBe(400);
  });
});
