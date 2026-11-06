import { Writable } from 'node:stream';
import type { MeView, NegotiationOutcome, OrderView, TokenResponse } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PiiService } from '../../src/modules/pii/index.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import { findPii } from '../../src/shared/observability/redact.js';
import {
  ADDRESS,
  adminToken,
  BUYER_EMAIL,
  BUYER_PHONE,
  call,
  completeCheckout,
  createShopApp,
  getOrder,
  ok,
  pay,
  startCheckout,
  type ShopApp,
} from '../support/shop.js';

const PASSWORD = 'Secret-pass-2026';

describe('@lite negative: personal data never leaks, and erasure leaves none behind', () => {
  let app: ShopApp;
  const logs: string[] = [];

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    app = await createShopApp({ logger: createLogger('debug', sink), env: { LOG_LEVEL: 'debug' } });
  });
  afterAll(async () => app.close());

  it('a full negotiated checkout writes no PII to logs, audit, traces, transcripts, offers or the outbox', async () => {
    const reg = ok<TokenResponse>(
      await call(app, 'POST', '/api/v1/auth/register', {
        body: { email: BUYER_EMAIL, password: PASSWORD, name: ADDRESS.name, consents: { terms: true } },
      }),
      201,
    );
    await call(app, 'POST', '/api/v1/auth/login', {
      body: { email: BUYER_EMAIL, password: 'wrong-password-1' },
    });
    const opened = ok<NegotiationOutcome>(
      await call(app, 'POST', '/api/v1/quotes', {
        token: reg.accessToken,
        body: { sku: 'THOCK-TK87-RED', quantity: 1 },
      }),
      201,
    );
    const offer = await call(app, 'POST', `/api/v1/negotiations/${opened.negotiationId}/offers`, {
      token: reg.accessToken,
      body: { unitPricePaise: 520_000, message: `Call me on ${BUYER_PHONE} or mail ${BUYER_EMAIL}` },
    });
    const quote = ok<NegotiationOutcome>(offer, 200).quote!;
    const session = await startCheckout(app, { quoteToken: quote.token }, reg.accessToken);
    const order = ok<OrderView>(await completeCheckout(app, session, {}, { token: reg.accessToken }), 201);
    await pay(app, order);
    const admin = await adminToken(app);
    ok(
      await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/ship`, {
        token: admin,
        body: { trackingNumber: 'TRK-PII-1' },
      }),
      200,
    );
    ok(await call(app, 'POST', `/api/v1/admin/orders/${order.orderId}/deliver`, { token: admin }), 200);
    await app.drain();
    expect((await getOrder(app, order)).status).toBe('delivered');

    // Every field of every line, except pino's epoch-millisecond `time` (13 digits that can pass the card check).
    const text = logs
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const { time: _time, ...entry } = JSON.parse(line) as Record<string, unknown>;
        return JSON.stringify(entry);
      })
      .join('\n');
    expect(text).toContain('order email'); // the mailer ran and logged something
    expect(findPii(text).map((f) => `${f.type}: ${text.slice(f.start - 30, f.end + 5)}`)).toEqual([]);
    for (const needle of [BUYER_EMAIL, BUYER_PHONE, ADDRESS.line1]) expect(text).not.toContain(needle);

    const tables: [string, string][] = [
      ['audit_log', "data::text || coalesce(target, '')"],
      ['llm_traces', 'input_redacted || output_redacted'],
      ['chat_messages', 'text_redacted'],
      ['offers', "coalesce(message, '')"],
      ['outbox_events', 'payload::text'],
      ['order_events', "coalesce(note, '') || actor"],
      ['orders', 'row_to_json(orders)::text'],
      ['idempotency_keys', "coalesce(response_body::text, '')"],
      ['users', 'row_to_json(users)::text'],
    ];
    for (const [table, expr] of tables) {
      const found = await app.infra.database.query<{ t: string }>(`SELECT ${expr} AS t FROM ${table}`);
      const all = found.map((r) => r.t).join('\n');
      for (const needle of [BUYER_EMAIL, BUYER_PHONE, ADDRESS.line1])
        expect(all, `${table} holds ${needle}`).not.toContain(needle);
    }
  });

  it('erasure crypto-shreds the person: nothing decryptable, no blind index, empty export, no sign-in', async () => {
    const email = 'erase.me@example.com';
    const reg = ok<TokenResponse>(
      await call(app, 'POST', '/api/v1/auth/register', {
        body: { email, password: PASSWORD, name: 'Erase Me', consents: { terms: true } },
      }),
      201,
    );
    const { customerToken } = ok<MeView>(
      await call(app, 'GET', '/api/v1/me', { token: reg.accessToken }),
      200,
    );
    const cart = ok<{ cartId: string }>(
      await call(app, 'POST', '/api/v1/carts', { token: reg.accessToken }),
      201,
    );
    ok(
      await call(app, 'POST', `/api/v1/carts/${cart.cartId}/lines`, {
        body: { sku: 'KOKOA-MINI-13G', quantity: 1 },
      }),
      200,
    );
    const session = await startCheckout(app, { cartId: cart.cartId }, reg.accessToken);
    const order = ok<OrderView>(
      await completeCheckout(app, session, { email }, { token: reg.accessToken }),
      201,
    );

    expect(
      (await call(app, 'POST', '/api/v1/me/erase', { token: reg.accessToken, body: { confirm: 'yes' } }))
        .statusCode,
    ).toBe(400);
    expect(
      ok(
        await call(app, 'POST', '/api/v1/me/erase', { token: reg.accessToken, body: { confirm: 'ERASE' } }),
        200,
      ),
    ).toEqual({ ok: true });

    const [c] = await app.infra.database.query<Record<string, unknown>>(
      'SELECT * FROM pii.customers WHERE token = $1',
      [customerToken],
    );
    expect(c).toMatchObject({
      wrapped_dek: null,
      email_enc: null,
      email_bidx: null,
      phone_enc: null,
      phone_bidx: null,
      name_enc: null,
    });
    expect(c!.erased_at).not.toBeNull();
    const [addr] = await app.infra.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pii.addresses WHERE customer_token = $1',
      [customerToken],
    );
    expect(addr!.n).toBe(0);
    expect(await app.app.get(PiiService).customer(customerToken)).toBeNull();

    const [u] = await app.infra.database.query<{ status: string; email_bidx: string; mfa_secret_enc: null }>(
      'SELECT * FROM users WHERE customer_token = $1',
      [customerToken],
    );
    expect(u).toMatchObject({ status: 'erased', mfa_secret_enc: null });
    expect(u!.email_bidx).toMatch(/^erased:/);

    // The order stays for the books, holding only opaque tokens.
    const [o] = await app.infra.database.query<{ customer_token: string; address_token: string }>(
      'SELECT * FROM orders WHERE id = $1',
      [order.orderId],
    );
    expect(o!.customer_token).toBe(customerToken);
    const [resolved] = await app.infra.database.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pii.addresses WHERE token = $1',
      [o!.address_token],
    );
    expect(resolved!.n).toBe(0);

    const exported = ok<{ customer: unknown; addresses: unknown[] }>(
      await call(app, 'GET', '/api/v1/me/export', { token: reg.accessToken }),
      200,
    );
    expect(exported.customer).toBeNull();
    expect(exported.addresses).toEqual([]);
    expect(
      (await call(app, 'POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } })).statusCode,
    ).toBe(401);
    expect(
      (await call(app, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: reg.refreshToken } }))
        .statusCode,
    ).toBe(401);
    const audit = await app.infra.database.query<{ data: unknown }>(
      `SELECT data FROM audit_log WHERE action = 'identity.erased' AND target = $1`,
      [customerToken],
    );
    expect(audit).toHaveLength(1);

    // The email is free again: no blind index survives.
    expect(
      (
        await call(app, 'POST', '/api/v1/auth/register', {
          body: { email, password: PASSWORD, name: 'New Me', consents: { terms: true } },
        })
      ).statusCode,
    ).toBe(201);
  });
});
