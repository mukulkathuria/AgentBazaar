import type { MeView, NegotiationOutcome, TokenResponse } from '@agentbazaar/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../../src/shared/crypto/primitives.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import {
  ADDRESS,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminToken,
  BUYER_EMAIL,
  BUYER_PHONE,
  buy,
  call,
  createShopApp,
  ok,
  registerCustomer,
  type ShopApp,
} from '../support/shop.js';

interface AgentClient {
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  status: string;
}

describe('@lite identity: accounts, sessions, MFA and agent clients', () => {
  let app: ShopApp;
  let clock: ManualClock;
  const login = (body: Record<string, unknown>) => call(app, 'POST', '/api/v1/auth/login', { body });

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
  });
  afterAll(async () => app.close());

  it('registers a customer with consents and shows the profile from the PII vault', async () => {
    const res = await call(app, 'POST', '/api/v1/auth/register', {
      body: {
        email: 'meera@example.com',
        password: 'Secret-pass-2026',
        name: 'Meera Iyer',
        consents: { terms: true, marketing: false },
      },
    });
    const t = ok<TokenResponse>(res, 201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(t).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      role: 'customer',
      refreshToken: expect.stringMatching(/^rt_/),
    });

    const me = ok<MeView>(await call(app, 'GET', '/api/v1/me', { token: t.accessToken }), 200);
    expect(me).toMatchObject({
      role: 'customer',
      name: 'Meera Iyer',
      email: 'meera@example.com',
      mfaEnabled: false,
    });
    expect(me.consents.map((c) => [c.purpose, c.granted]).sort()).toEqual([
      ['marketing', false],
      ['terms', true],
    ]);
    const updated = ok<MeView>(
      await call(app, 'PUT', '/api/v1/me/consents', {
        token: t.accessToken,
        body: { purpose: 'marketing', granted: true },
      }),
      200,
    );
    expect(updated.consents.find((c) => c.purpose === 'marketing')!.granted).toBe(true);

    const [u] = await app.infra.database.query<Record<string, unknown>>(
      `SELECT * FROM users WHERE customer_token = $1`,
      [me.customerToken],
    );
    expect(JSON.stringify(u)).not.toContain('meera');
    expect(String(u!.password_hash)).toMatch(/^scrypt\$/);

    const again = await call(app, 'POST', '/api/v1/auth/register', {
      body: {
        email: 'MEERA@example.com',
        password: 'Other-pass-2026',
        name: 'Someone',
        consents: { terms: true },
      },
    });
    expect(again.statusCode).toBe(409);
  });

  it('rotates refresh tokens and ends every session when a rotated token is reused', async () => {
    const first = await registerCustomer(app);
    const second = ok<TokenResponse>(
      await call(app, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: first.refreshToken } }),
      200,
    );
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await call(app, 'GET', '/api/v1/me', { token: second.accessToken })).statusCode).toBe(200);

    const reuse = await call(app, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: first.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    // The reuse revoked the whole family, including the token issued by the legitimate rotation.
    expect(
      (await call(app, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: second.refreshToken } }))
        .statusCode,
    ).toBe(401);
  });

  it('gives one generic answer for a wrong password and an unknown email, and locks after 5 failures for 15 minutes', async () => {
    const email = 'lock-me@example.com';
    await registerCustomer(app, email);
    const errorOf = (r: LightMyRequestResponse) => {
      const e = r.json<{ error: { code: string; message: string } }>().error;
      return [r.statusCode, e.code, e.message];
    };
    const unknown = await login({ email: 'nobody-here@example.com', password: 'whatever-123' });
    const wrong = await login({ email, password: 'wrong-password-1' });
    expect(errorOf(unknown)[0]).toBe(401);
    expect(errorOf(wrong)).toEqual(errorOf(unknown));

    for (let i = 0; i < 4; i++)
      expect((await login({ email, password: `wrong-password-${i}` })).statusCode).toBe(401);
    // Locked now: even the right password is refused.
    expect((await login({ email, password: 'Secret-pass-2026' })).statusCode).toBe(401);
    clock.advance(16 * 60_000);
    expect((await login({ email, password: 'Secret-pass-2026' })).statusCode).toBe(200);
  });

  it('requires a valid TOTP from admins with MFA, and admin routes accept that session', async () => {
    expect((await login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).statusCode).toBe(401);
    expect((await login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, totp: '000000' })).statusCode).toBe(
      401,
    );
    const token = await adminToken(app);
    expect((await call(app, 'GET', '/api/v1/admin/agent-clients', { token })).statusCode).toBe(200);
  });

  it('keeps admins without MFA out of admin routes until they enrol', async () => {
    const email = 'new-admin@example.com';
    const t = await registerCustomer(app, email);
    const { customerToken } = ok<MeView>(await call(app, 'GET', '/api/v1/me', { token: t.accessToken }), 200);
    await app.infra.database.query(`UPDATE users SET role = 'admin' WHERE customer_token = $1`, [
      customerToken,
    ]);
    const noMfa = ok<TokenResponse>(await login({ email, password: 'Secret-pass-2026' }), 200);
    expect(noMfa.role).toBe('admin');
    const denied = await call(app, 'GET', '/api/v1/admin/agent-clients', { token: noMfa.accessToken });
    expect(denied.statusCode).toBe(403);

    const { secret, otpauthUrl } = ok<{ secret: string; otpauthUrl: string }>(
      await call(app, 'POST', '/api/v1/me/mfa/setup', { token: noMfa.accessToken }),
      200,
    );
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(
      (
        await call(app, 'POST', '/api/v1/me/mfa/verify', {
          token: noMfa.accessToken,
          body: { code: '123456' },
        })
      ).statusCode,
    ).toBe(400);
    ok(
      await call(app, 'POST', '/api/v1/me/mfa/verify', {
        token: noMfa.accessToken,
        body: { code: totp(secret, clock.now()) },
      }),
      200,
    );
    expect((await call(app, 'POST', '/api/v1/me/mfa/setup', { token: noMfa.accessToken })).statusCode).toBe(
      409,
    );

    const [u] = await app.infra.database.query<{ mfa_secret_enc: string }>(
      `SELECT mfa_secret_enc FROM users WHERE customer_token = $1`,
      [customerToken],
    );
    expect(u!.mfa_secret_enc).toMatch(/^v1\./);
    expect(u!.mfa_secret_enc).not.toContain(secret);
    const withMfa = ok<TokenResponse>(
      await login({ email, password: 'Secret-pass-2026', totp: totp(secret, clock.now()) }),
      200,
    );
    expect(
      (await call(app, 'GET', '/api/v1/admin/agent-clients', { token: withMfa.accessToken })).statusCode,
    ).toBe(200);
  });

  it('issues agent tokens by client credentials (JSON or form), within the client scopes', async () => {
    const admin = await adminToken(app);
    const created = ok<AgentClient>(
      await call(app, 'POST', '/api/v1/admin/agent-clients', {
        token: admin,
        body: { name: 'Quote bot', scopes: ['catalog:read', 'quote:create'] },
      }),
      201,
    );
    expect(created.clientSecret).toEqual(expect.any(String));
    const listed = ok<AgentClient[]>(
      await call(app, 'GET', '/api/v1/admin/agent-clients', { token: admin }),
      200,
    );
    expect(listed.find((c) => c.clientId === created.clientId)).not.toHaveProperty('clientSecret');

    const creds = {
      grant_type: 'client_credentials',
      client_id: created.clientId,
      client_secret: created.clientSecret!,
    };
    const json = ok<{ access_token: string; scope: string; token_type: string }>(
      await call(app, 'POST', '/oauth/token', { body: creds }),
      200,
    );
    expect(json).toMatchObject({ token_type: 'Bearer', scope: 'catalog:read quote:create', expires_in: 900 });
    const form = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ...creds, scope: 'quote:create' }).toString(),
    });
    const narrowed = ok<{ access_token: string; scope: string }>(form, 200);
    expect(narrowed.scope).toBe('quote:create');

    const quote = await call(app, 'POST', '/api/v1/quotes', {
      token: narrowed.access_token,
      body: { sku: 'VOLTEDGE-1000P', quantity: 1 },
    });
    expect(ok<NegotiationOutcome>(quote, 201).quote).not.toBeNull();

    expect(
      (await call(app, 'POST', '/oauth/token', { body: { ...creds, scope: 'order:create' } })).statusCode,
    ).toBe(400);
    expect(
      (await call(app, 'POST', '/oauth/token', { body: { ...creds, client_secret: 'x'.repeat(40) } }))
        .statusCode,
    ).toBe(401);
    await app.infra.database.query(`UPDATE agent_clients SET status = 'disabled' WHERE client_id = $1`, [
      created.clientId,
    ]);
    expect((await call(app, 'POST', '/oauth/token', { body: creds })).statusCode).toBe(401);
  });

  it('exports what the store holds about a customer: profile, addresses, consents and orders', async () => {
    const t = await registerCustomer(app, BUYER_EMAIL);
    const { order } = await buy(app, { sku: 'KOKOA-MINI-13G', quantity: 1 }, { token: t.accessToken });
    const data = ok<{
      account: object;
      customer: object;
      addresses: unknown[];
      consents: { purpose: string }[];
      orders: { orderId: string }[];
    }>(await call(app, 'GET', '/api/v1/me/export', { token: t.accessToken }), 200);
    expect(data.account).toMatchObject({ role: 'customer', mfaEnabled: false });
    expect(data.customer).toEqual({ email: BUYER_EMAIL, name: ADDRESS.name, phone: BUYER_PHONE });
    expect(data.addresses).toEqual([ADDRESS]);
    expect(data.consents.map((c) => c.purpose).sort()).toEqual(['marketing', 'order_fulfilment', 'terms']);
    expect(data.orders.map((o) => o.orderId)).toEqual([order.orderId]);
  });
});
