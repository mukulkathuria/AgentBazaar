// Failure injection (plan: resilience suite; "dependency outage: payment gateway, LLM provider, AI service,
// database failover"). Postgres and Valkey sit behind Toxiproxy proxies (names prefixed t3-); the payment
// gateway, the AI service and the LLM provider are local fake upstreams the test switches between healthy,
// erroring, resetting and hanging. Every scenario ends by checking the system recovered.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatReply, OrderView } from '@agentbazaar/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderPlacement } from '../../src/modules/orders/application/order-placement.js';
import { HASH_DIM } from '../../src/modules/search/domain/embeddings.js';
import {
  call,
  completeCheckout,
  createShopApp,
  idemKey,
  newCart,
  ok,
  startCheckout,
  stockOf,
  type ShopApp,
  type ShopOptions,
} from '../support/shop.js';

const TOXIPROXY = process.env.TOXIPROXY_URL ?? 'http://localhost:8474';
const SKU = 'THOCK-TK87-RED';

async function toxiproxy(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${TOXIPROXY}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    throw new Error(`Toxiproxy ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  }
}

/** One Toxiproxy proxy in front of a compose service, listening on a port the compose file publishes. */
class ToxicProxy {
  private readonly toxics: string[] = [];

  constructor(
    readonly name: string,
    readonly port: number,
    private readonly upstream: string,
  ) {}

  async create(): Promise<void> {
    await this.destroy();
    await toxiproxy('POST', '/proxies', {
      name: this.name,
      listen: `0.0.0.0:${this.port}`,
      upstream: this.upstream,
    });
  }

  /** Disabled = full outage: Toxiproxy drops every connection and refuses new ones. */
  setEnabled(enabled: boolean): Promise<void> {
    return toxiproxy('POST', `/proxies/${this.name}`, { enabled });
  }

  async toxic(type: string, attributes: Record<string, number>): Promise<void> {
    const name = `${type}_downstream`;
    await toxiproxy('POST', `/proxies/${this.name}/toxics`, {
      name,
      type,
      stream: 'downstream',
      toxicity: 1,
      attributes,
    });
    this.toxics.push(name);
  }

  async heal(): Promise<void> {
    await this.setEnabled(true);
    for (const t of this.toxics.splice(0)) await toxiproxy('DELETE', `/proxies/${this.name}/toxics/${t}`);
  }

  destroy(): Promise<void> {
    return toxiproxy('DELETE', `/proxies/${this.name}`);
  }

  /** The same URL with this proxy's port, so the client connects through Toxiproxy. */
  via(url: string): string {
    const u = new URL(url);
    u.port = String(this.port);
    return u.toString();
  }
}

type Mode = 'ok' | 'error' | 'reset' | 'hang';

/** A remote dependency the test controls; `hits` counts the calls that reached it. */
class FakeUpstream {
  mode: Mode = 'ok';
  hits = 0;
  private readonly server: Server;
  private readonly hung: ServerResponse[] = [];

  constructor(private readonly answer: (req: IncomingMessage, body: string) => unknown) {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => this.handle(req, res, body));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: string): void {
    this.hits++;
    if (this.mode === 'reset') req.socket.destroy();
    else if (this.mode === 'hang') this.hung.push(res);
    else if (this.mode === 'error') res.writeHead(500).end('upstream exploded');
    else
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.answer(req, body)));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.hung.splice(0)) res.destroy();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** Circuit breakers reopen for a trial call 30 s after opening; they read the real clock. */
const BREAKER_RESET_MS = 30_500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await fn();
  return [result, performance.now() - started];
}

/** The standard error envelope with 503, and nothing internal: no stack frames, driver errors, SQL or buyer data. */
function expectUnavailable(res: LightMyRequestResponse): void {
  expect(res.statusCode, res.body).toBe(503);
  expect(res.json()).toEqual({
    error: { code: 'unavailable', message: expect.any(String), requestId: expect.any(String) },
  });
  expect(res.body).not.toMatch(
    /\bat \S+:\d+|ECONN|EPIPE|timeout exceeded|terminated|stream|postgres|valkey|select |insert |@example\.com|9876543210/i,
  );
}

/** Boots a seeded app whose database connections all go through `proxy` (test database and cleanup too). */
async function appBehind(proxy: ToxicProxy, opts: ShopOptions): Promise<ShopApp> {
  const direct = process.env.TEST_DATABASE_URL!;
  process.env.TEST_DATABASE_URL = proxy.via(direct);
  try {
    return await createShopApp(opts);
  } finally {
    process.env.TEST_DATABASE_URL = direct;
  }
}

describe('@growth resilience: Postgres outage through Toxiproxy', () => {
  const pg = new ToxicProxy('t3-pg', 26000, 'postgres:5432');
  let app: ShopApp;
  const search = () => call(app, 'GET', '/api/v1/products?q=keyboard');

  beforeAll(async () => {
    await pg.create();
    app = await appBehind(pg, { poolMax: 4, statementTimeoutMs: 1_000 });
  });
  afterEach(() => pg.heal());
  afterAll(async () => {
    await app?.close();
    await pg.destroy();
  });

  async function expectRecovered(): Promise<void> {
    await vi.waitFor(async () => expect((await search()).statusCode).toBe(200), {
      timeout: 15_000,
      interval: 250,
    });
    // More parallel requests than pooled connections: a connection left broken by the fault fails some of them.
    const statuses = await Promise.all(Array.from({ length: 12 }, async () => (await search()).statusCode));
    expect(statuses).toEqual(Array(12).fill(200));
    expect((await call(app, 'GET', '/readyz')).statusCode).toBe(200);
  }

  it('keeps serving reads with 250 ms of added latency', async () => {
    await pg.toxic('latency', { latency: 250 });
    const [res, ms] = await timed(search);
    expect(res.statusCode).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect((await call(app, 'GET', '/readyz')).statusCode).toBe(200);
  });

  it('fails fast with 503, reports not ready but stays live during a full outage, then recovers', async () => {
    expect((await search()).statusCode).toBe(200);
    await pg.setEnabled(false);
    const [res, ms] = await timed(search);
    expectUnavailable(res);
    expect(ms).toBeLessThan(2_000);
    expectUnavailable(await call(app, 'GET', '/readyz'));
    expect((await call(app, 'GET', '/healthz')).statusCode).toBe(200);
    await pg.heal();
    await expectRecovered();
  });

  it('answers 503 when connections are reset, then recovers', async () => {
    expect((await search()).statusCode).toBe(200);
    await pg.toxic('reset_peer', { timeout: 0 });
    expectUnavailable(await search());
    await pg.heal();
    await expectRecovered();
  });

  // Regression: each transaction whose BEGIN failed kept its pooled connection, so the pool drained for good.
  it('gets its connections back after more failed transactions than the pool holds', async () => {
    await pg.toxic('reset_peer', { timeout: 0 });
    for (let i = 0; i < 6; i++) expectUnavailable(await search()); // pool max is 4
    await pg.heal();
    await expectRecovered();
  });

  it('bounds a black-holed connection with a timeout instead of hanging, and leaves no broken connection behind', async () => {
    expect((await search()).statusCode).toBe(200);
    await pg.toxic('timeout', { timeout: 0 }); // drops every byte but keeps the sockets open
    const [res, ms] = await timed(search);
    expectUnavailable(res);
    expect(ms).toBeLessThan(12_000);
    await pg.heal();
    await expectRecovered();
  }, 60_000);

  it('never half-writes an order when the database dies mid-checkout; the same request completes after recovery', async () => {
    const before = await stockOf(app, SKU);
    const cartId = await newCart(app, [{ sku: SKU, quantity: 1 }]);
    const session = await startCheckout(app, { cartId });
    const key = idemKey();
    const placement = app.app.get(OrderPlacement);
    const place = placement.place.bind(placement);
    // The outage starts after the idempotency key is claimed, inside the order transaction.
    const spy = vi.spyOn(placement, 'place').mockImplementationOnce(async (...args) => {
      await pg.setEnabled(false);
      return place(...args);
    });
    expectUnavailable(await completeCheckout(app, session, { paymentMethod: 'cod' }, { key }));
    spy.mockRestore();
    await pg.heal();
    await expectRecovered();

    const ordersOf = async () =>
      (
        await app.infra.database.query<{ id: string; lines: number }>(
          'SELECT o.id, (SELECT count(*)::int FROM order_lines l WHERE l.order_id = o.id) AS lines FROM orders o WHERE o.checkout_session_id = $1',
          [session.sessionId],
        )
      ).map((o) => o.lines);
    expect(await ordersOf()).toEqual([]);

    // The outage also stopped the key from being released: a retry is refused as in progress until the
    // claim's one-minute lease lapses (aged here instead of waited for), then the same request goes through.
    expect((await completeCheckout(app, session, { paymentMethod: 'cod' }, { key })).statusCode).toBe(409);
    await app.infra.database.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '61 seconds' WHERE key = $1",
      [key],
    );
    const order = ok<OrderView>(await completeCheckout(app, session, { paymentMethod: 'cod' }, { key }), 201);
    const replay = ok<OrderView>(
      await completeCheckout(app, session, { paymentMethod: 'cod' }, { key }),
      201,
    );
    expect(replay.orderId).toBe(order.orderId);
    expect(await ordersOf()).toEqual([1]);
    const after = await stockOf(app, SKU);
    expect(after.reserved).toBeLessThanOrEqual(after.on_hand);
    expect(after.on_hand - after.reserved).toBe(before.on_hand - before.reserved - 1);
  }, 60_000);
});

describe('@growth resilience: Valkey outage through Toxiproxy', () => {
  const valkey = new ToxicProxy('t3-valkey', 26001, 'valkey:6379');
  let app: ShopApp;
  let agentToken: string;
  const quote = () =>
    call(app, 'POST', '/api/v1/quotes', { token: agentToken, body: { sku: SKU, quantity: 1 } });

  beforeAll(async () => {
    await valkey.create();
    const url = valkey.via(process.env.VALKEY_URL ?? 'redis://localhost:6379');
    app = await createShopApp({ env: { CACHE_ADAPTER: 'valkey', VALKEY_URL: url } });
    const { clientId, clientSecret } = app.seed.agentClient;
    agentToken = ok<{ access_token: string }>(
      await call(app, 'POST', '/oauth/token', {
        body: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
      }),
      200,
    ).access_token;
  });
  afterEach(() => valkey.heal());
  afterAll(async () => {
    await app?.close();
    await valkey.destroy();
  });

  it('keeps the storefront and checkout working, fails agent calls closed with 503, then recovers', async () => {
    expect((await quote()).statusCode).toBe(201);
    await valkey.setEnabled(false);
    // Buyers never touch the cache: search and a full checkout still work.
    expect((await call(app, 'GET', '/api/v1/products?q=keyboard')).statusCode).toBe(200);
    const session = await startCheckout(app, { cartId: await newCart(app, [{ sku: SKU, quantity: 1 }]) });
    expect((await completeCheckout(app, session, { paymentMethod: 'cod' })).statusCode).toBe(201);
    // Agent quotas live in the cache; without it the API refuses rather than serve unmetered traffic.
    const [res, ms] = await timed(quote);
    expectUnavailable(res);
    expect(ms).toBeLessThan(2_000);
    await valkey.heal();
    await vi.waitFor(async () => expect((await quote()).statusCode).toBe(201), {
      timeout: 15_000,
      interval: 250,
    });
  }, 60_000);

  it('serves agent calls with 200 ms of added cache latency', async () => {
    await vi.waitFor(async () => expect((await quote()).statusCode).toBe(201), {
      timeout: 15_000,
      interval: 250,
    });
    await valkey.toxic('latency', { latency: 200 });
    const [res, ms] = await timed(quote);
    expect(res.statusCode).toBe(201);
    expect(ms).toBeGreaterThanOrEqual(200);
  });
});

describe('@growth resilience: payment gateway outage (Razorpay adapter against a failing gateway)', () => {
  const gateway: FakeUpstream = new FakeUpstream((): unknown => ({ id: `order_fake${gateway.hits}` }));
  let app: ShopApp;

  beforeAll(async () => {
    const base = await gateway.start();
    const realFetch = globalThis.fetch;
    // The adapter captures fetch when it is built: send its fixed API host to the fake gateway.
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      realFetch(String(input).replace('https://api.razorpay.com', base), init),
    );
    try {
      app = await createShopApp({
        env: {
          PAYMENT_ADAPTER: 'razorpay',
          RAZORPAY_KEY_ID: 'rzp_test_fake',
          RAZORPAY_KEY_SECRET: 'fake-key-secret',
          RAZORPAY_WEBHOOK_SECRET: 'fake-webhook-secret',
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  afterAll(async () => {
    await app?.close();
    await gateway.stop();
  });

  async function placeOnline(): Promise<{ order: OrderView; ms: number; providerRef: string | null }> {
    const session = await startCheckout(app, { cartId: await newCart(app, [{ sku: SKU, quantity: 1 }]) });
    const [res, ms] = await timed(() => completeCheckout(app, session, { paymentMethod: 'online' }));
    const order = ok<OrderView>(res, 201);
    const [p] = await app.infra.database.query<{ provider_order_id: string | null }>(
      'SELECT provider_order_id FROM payments WHERE order_id = $1',
      [order.orderId],
    );
    return { order, ms, providerRef: p?.provider_order_id ?? null };
  }

  it('keeps every order when the gateway times out, resets or errors, opens the breaker, then recovers', async () => {
    expect((await placeOnline()).providerRef).toBe('order_fake1');

    gateway.mode = 'hang';
    const slow = await placeOnline();
    expect(slow).toMatchObject({ order: { status: 'pending_payment' }, providerRef: null });
    expect(slow.ms).toBeLessThan(10_000); // the adapter's 8 s timeout, not a hung request

    for (const mode of ['reset', 'reset', 'error', 'error'] as const) {
      gateway.mode = mode;
      expect(await placeOnline()).toMatchObject({ order: { status: 'pending_payment' }, providerRef: null });
    }
    // Five failures in a row open the breaker: the next order is placed without calling the gateway.
    const hits = gateway.hits;
    const fast = await placeOnline();
    expect(gateway.hits).toBe(hits);
    expect(fast).toMatchObject({ order: { status: 'pending_payment' }, providerRef: null });
    expect(fast.ms).toBeLessThan(1_000);

    // After the breaker's 30 s reset window one trial call reaches the healed gateway and closes it.
    gateway.mode = 'ok';
    await sleep(BREAKER_RESET_MS);
    expect((await placeOnline()).providerRef).toMatch(/^order_fake\d+$/);
    expect((await placeOnline()).providerRef).toMatch(/^order_fake\d+$/);
  }, 90_000);

  it('holds stock for exactly the orders it kept and leaves no order without lines or a payment record', async () => {
    const [counts] = await app.infra.database.query<{
      pending: number;
      without_lines: number;
      without_payment: number;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'pending_payment')::int AS pending,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id))::int AS without_lines,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id))::int AS without_payment
         FROM orders o`,
    );
    expect(counts).toEqual({ pending: 9, without_lines: 0, without_payment: 0 });
    const stock = await stockOf(app, SKU);
    expect(stock.reserved).toBe(9);
    expect(stock.reserved).toBeLessThanOrEqual(stock.on_hand);
  });
});

describe('@growth resilience: AI service and LLM provider outage', () => {
  const MODEL_TEXT = 'Here are a few keyboards I found for you.';
  const ai = new FakeUpstream((req, body) =>
    req.url === '/v1/embed'
      ? {
          model: 'fake',
          dim: HASH_DIM,
          vectors: (JSON.parse(body) as { texts: string[] }).texts.map(() =>
            Array<number>(HASH_DIM).fill(1 / 16),
          ),
        }
      : {
          intent: 'search',
          complexity: 'low',
          risk: 'low',
          language: 'en',
          confidence: 0.9,
          entities: { amount_inr: null, quantity: null },
          model: 'fake',
        },
  );
  const llm = new FakeUpstream(() => ({
    choices: [{ message: { content: MODEL_TEXT }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 12 },
  }));
  let app: ShopApp;
  let sessionId: string;
  const ask = () =>
    call(app, 'POST', `/api/v1/chat/sessions/${sessionId}/messages`, {
      body: { text: 'show me mechanical keyboards' },
    });

  beforeAll(async () => {
    const [aiUrl, llmUrl] = await Promise.all([ai.start(), llm.start()]);
    app = await createShopApp({
      env: {
        CLASSIFIER_ADAPTER: 'ai-service',
        EMBEDDINGS_ADAPTER: 'ai-service',
        AI_SERVICE_URL: aiUrl,
        LLM_ADAPTER: 'openai-compatible',
        OPENAI_COMPAT_BASE_URL: `${llmUrl}/v1`,
      },
    });
    sessionId = ok<{ sessionId: string }>(
      await call(app, 'POST', '/api/v1/chat/sessions', { body: { language: 'en' } }),
      201,
    ).sessionId;
  });
  afterAll(async () => {
    await app?.close();
    await Promise.all([ai.stop(), llm.stop()]);
  });

  it('falls back to the rules classifier, hash embeddings and the template, opens the breakers, then recovers', async () => {
    expect(ok<ChatReply>(await ask(), 200).message).toBe(MODEL_TEXT);

    ai.mode = 'reset';
    llm.mode = 'error';
    for (let i = 0; i < 5; i++) {
      const reply = ok<ChatReply>(await ask(), 200);
      expect(reply).toMatchObject({ intent: 'search', handoff: false });
      expect(reply.products.length).toBeGreaterThan(0);
      expect(reply.message).not.toBe(MODEL_TEXT);
    }
    const [aiHits, llmHits] = [ai.hits, llm.hits];
    const [res, ms] = await timed(ask);
    expect(ok<ChatReply>(res, 200).products.length).toBeGreaterThan(0);
    expect([ai.hits, llm.hits]).toEqual([aiHits, llmHits]); // every breaker is open: nothing reaches the services
    expect(ms).toBeLessThan(1_000);
    expect((await call(app, 'GET', '/api/v1/products?q=keyboard')).statusCode).toBe(200);

    ai.mode = 'ok';
    llm.mode = 'ok';
    await sleep(BREAKER_RESET_MS);
    expect(ok<ChatReply>(await ask(), 200).message).toBe(MODEL_TEXT);
    expect(ai.hits).toBeGreaterThan(aiHits);
  }, 90_000);
});
