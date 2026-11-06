import type { CheckoutSessionView, OrderView } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CartService } from '../../src/modules/orders/index.js';
import { usingRealPostgres } from '../support/test-db.js';
import {
  call,
  completeCheckout,
  createShopApp,
  idemKey,
  ok,
  pay,
  stockOf,
  type ShopApp,
} from '../support/shop.js';

const SKU = 'VOLTEDGE-850G';
const UNITS = 10;
// PGlite is a single connection, so its "parallel" buyers queue up; real Postgres runs them truly in parallel.
const BUYERS = usingRealPostgres() ? 1000 : 200;

describe(`@lite concurrency: ${BUYERS} parallel buyers for ${UNITS} units`, () => {
  let app: ShopApp;
  beforeAll(async () => {
    app = await createShopApp({ poolMax: 50 });
    await app.infra.database.query(
      `UPDATE stock_levels SET on_hand = $1, reserved = 0 WHERE variant_id = (SELECT id FROM variants WHERE sku = $2)`,
      [UNITS, SKU],
    );
  }, 120_000);
  afterAll(async () => app.close());

  it(
    'sells exactly the stock on hand and never lets reserved exceed on_hand',
    { timeout: 300_000 },
    async () => {
      const carts = app.app.get(CartService);
      const cartIds: string[] = [];
      for (let i = 0; i < BUYERS; i += 50) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(50, BUYERS - i) }, async () => {
            const { cartId } = await carts.create(`anon:buyer-${i}`);
            await carts.addLine(cartId, { sku: SKU, quantity: 1 });
            return cartId;
          }),
        );
        cartIds.push(...batch);
      }

      const results = await Promise.all(
        cartIds.map((cartId) =>
          call(app, 'POST', '/api/v1/checkout/sessions', {
            body: { cartId },
            headers: { 'idempotency-key': idemKey() },
          }),
        ),
      );
      const byStatus = new Map<number, number>();
      for (const r of results) byStatus.set(r.statusCode, (byStatus.get(r.statusCode) ?? 0) + 1);
      expect(Object.fromEntries(byStatus)).toEqual({ 201: UNITS, 409: BUYERS - UNITS });
      expect(
        results
          .filter((r) => r.statusCode === 409)
          .every((r) => r.json<{ error: { code: string } }>().error.code === 'out_of_stock'),
      ).toBe(true);
      expect(await stockOf(app, SKU)).toEqual({ on_hand: UNITS, reserved: UNITS });

      // The winners pay; stock leaves the shelf exactly once per unit.
      const sessions = results.filter((r) => r.statusCode === 201).map((r) => r.json<CheckoutSessionView>());
      for (const s of sessions) await pay(app, ok<OrderView>(await completeCheckout(app, s), 201));
      expect(await stockOf(app, SKU)).toEqual({ on_hand: 0, reserved: 0 });
      const [paid] = await app.infra.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE l.sku = $1 AND o.status = 'paid'`,
        [SKU],
      );
      expect(paid!.n).toBe(UNITS);
      const [bad] = await app.infra.database.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM stock_levels WHERE reserved > on_hand OR on_hand < 0',
      );
      expect(bad!.n).toBe(0);
    },
  );
});
