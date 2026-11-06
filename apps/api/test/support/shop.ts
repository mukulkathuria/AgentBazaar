import { randomUUID } from 'node:crypto';
import { loadConfig } from '@agentbazaar/config';
import type {
  AddressInput,
  CartLineInput,
  CheckoutSessionView,
  CompleteCheckoutInput,
  OrderView,
  TokenResponse,
} from '@agentbazaar/contracts';
import type { LightMyRequestResponse } from 'fastify';
import type { Logger } from 'pino';
import { createApp } from '../../src/bootstrap/create-app.js';
import { seedDemo, type SeedResult } from '../../src/cli/seed.js';
import { totp } from '../../src/shared/crypto/primitives.js';
import type { Clock } from '../../src/shared/kernel/clock.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import type { TestApp } from './test-app.js';
import { createTestDb } from './test-db.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'Admin-pass-2026';
export const BUYER_EMAIL = 'asha.verma@example.com';
export const BUYER_PHONE = '9876543210';
export const ADDRESS: AddressInput = {
  name: 'Asha Verma',
  phone: BUYER_PHONE,
  line1: '12 MG Road',
  city: 'New Delhi',
  stateCode: 'DL',
  pincode: '110001',
};

export interface ShopApp extends TestApp {
  seed: SeedResult;
  clock: Clock;
}

export interface ShopOptions {
  env?: Record<string, string>;
  clock?: Clock;
  logger?: Logger;
  poolMax?: number;
  /** Real Postgres only: a short statement timeout keeps failure-injection suites fast. */
  statementTimeoutMs?: number;
}

/** A seeded test app (hero products, GST rates, an MFA admin, a demo agent client). PGlite unless TEST_DATABASE_URL is set. */
export async function createShopApp(opts: ShopOptions = {}): Promise<ShopApp> {
  // Small pools by default: each new Postgres connection costs a process spawn, and parallel suites
  // opening dozens at once can outlast the pool's 5 s connect timeout on slower hosts.
  const testDb = await createTestDb({
    poolMax: opts.poolMax ?? 6,
    ...(opts.statementTimeoutMs ? { statementTimeoutMs: opts.statementTimeoutMs } : {}),
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_DRIVER: testDb.url ? 'postgres' : 'pglite',
    ...(testDb.url ? { DATABASE_URL: testDb.url } : {}),
    RATE_LIMIT_PER_MINUTE: '100000',
    PUBLIC_API_URL: 'http://api.test',
    PUBLIC_WEB_URL: 'http://web.test',
    ...opts.env,
  });
  const running = await createApp(config, {
    database: testDb.database,
    background: false,
    logger: opts.logger ?? createLogger('silent'),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const seed = await seedDemo(running, {
    products: 9,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
  });
  return {
    ...running,
    seed,
    clock: running.infra.clock,
    inject: (o) => running.app.inject(o),
    drain: () => running.infra.relay.drain(),
    async close() {
      await running.close();
      await testDb.cleanup();
    },
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function call(
  app: ShopApp,
  method: Method,
  url: string,
  opts: { body?: unknown; token?: string | undefined; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(opts.body === undefined ? {} : { payload: opts.body as Record<string, unknown> }),
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
  });
}

/** Asserts the status and returns the JSON body; the error shows the response body for quick diagnosis. */
export function ok<T>(res: LightMyRequestResponse, status: number): T {
  if (res.statusCode !== status)
    throw new Error(`Expected HTTP ${status}, got ${res.statusCode}: ${res.body}`);
  return res.json<T>();
}

export const idemKey = (): string => `k-${randomUUID()}`;

export async function newCart(app: ShopApp, lines: CartLineInput[], token?: string): Promise<string> {
  const { cartId } = ok<{ cartId: string }>(await call(app, 'POST', '/api/v1/carts', { token }), 201);
  for (const body of lines)
    ok(await call(app, 'POST', `/api/v1/carts/${cartId}/lines`, { body, token }), 200);
  return cartId;
}

export async function startCheckout(
  app: ShopApp,
  body: { cartId: string } | { quoteToken: string },
  token?: string,
): Promise<CheckoutSessionView> {
  return ok<CheckoutSessionView>(
    await call(app, 'POST', '/api/v1/checkout/sessions', {
      body,
      token,
      headers: { 'idempotency-key': idemKey() },
    }),
    201,
  );
}

export function completeCheckout(
  app: ShopApp,
  session: { sessionId: string; token?: string | undefined },
  input: Partial<CompleteCheckoutInput> = {},
  opts: { token?: string; key?: string } = {},
): Promise<LightMyRequestResponse> {
  return call(app, 'POST', `/api/v1/checkout/sessions/${session.sessionId}/complete?t=${session.token}`, {
    body: { email: BUYER_EMAIL, address: ADDRESS, paymentMethod: 'online', acceptTerms: true, ...input },
    token: opts.token,
    headers: { 'idempotency-key': opts.key ?? idemKey() },
  });
}

/** Cart -> checkout -> complete, returning the new order (with its one-time access token). */
export async function buy(
  app: ShopApp,
  line: CartLineInput,
  opts: { method?: 'online' | 'cod'; token?: string } = {},
): Promise<{ session: CheckoutSessionView; order: OrderView }> {
  const cartId = await newCart(app, [line], opts.token);
  const session = await startCheckout(app, { cartId }, opts.token);
  const order = ok<OrderView>(
    await completeCheckout(
      app,
      session,
      { paymentMethod: opts.method ?? 'online' },
      { ...(opts.token ? { token: opts.token } : {}) },
    ),
    201,
  );
  return { session, order };
}

export const paymentIdOf = (order: OrderView): string => {
  const id = /\/pay\/mock\/([0-9a-f-]{36})/.exec(order.paymentUrl ?? '')?.[1];
  if (!id) throw new Error(`Order ${order.number} has no mock payment link`);
  return id;
};

/** The buyer pays on the mock gateway; the outbox is then drained so the order reacts. */
export async function pay(
  app: ShopApp,
  order: OrderView,
  outcome: 'success' | 'failure' = 'success',
): Promise<string> {
  const id = paymentIdOf(order);
  ok(await call(app, 'POST', `/api/v1/mock-gateway/payments/${id}/complete`, { body: { outcome } }), 200);
  await app.drain();
  return id;
}

export async function getOrder(
  app: ShopApp,
  order: { orderId: string; accessToken?: string | undefined },
): Promise<OrderView> {
  return ok<OrderView>(await call(app, 'GET', `/api/v1/orders/${order.orderId}?t=${order.accessToken}`), 200);
}

export async function adminToken(app: ShopApp): Promise<string> {
  const code = totp(app.seed.admin!.totpSecret, app.clock.now());
  return ok<TokenResponse>(
    await call(app, 'POST', '/api/v1/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, totp: code },
    }),
    200,
  ).accessToken;
}

export async function registerCustomer(
  app: ShopApp,
  email = `buyer-${randomUUID().slice(0, 8)}@example.com`,
): Promise<TokenResponse> {
  const body = { email, password: 'Secret-pass-2026', name: 'Test Buyer', consents: { terms: true } };
  return ok<TokenResponse>(await call(app, 'POST', '/api/v1/auth/register', { body }), 201);
}

export async function stockOf(app: ShopApp, sku: string): Promise<{ on_hand: number; reserved: number }> {
  const [r] = await app.infra.database.query<{ on_hand: number; reserved: number }>(
    'SELECT s.on_hand, s.reserved FROM stock_levels s JOIN variants v ON v.id = s.variant_id WHERE v.sku = $1',
    [sku],
  );
  return r!;
}

export async function paymentStatus(app: ShopApp, orderId: string): Promise<string | undefined> {
  const [r] = await app.infra.database.query<{ status: string }>(
    `SELECT status FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [orderId],
  );
  return r?.status;
}
