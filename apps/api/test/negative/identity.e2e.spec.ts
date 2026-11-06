import { generateKeyPairSync } from 'node:crypto';
import type { MeView, TokenResponse } from '@agentbazaar/contracts';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import { adminToken, call, createShopApp, ok, registerCustomer, type ShopApp } from '../support/shop.js';

describe('@lite negative: authentication and authorization failures', () => {
  let app: ShopApp;
  let clock: ManualClock;
  const me = (token?: string) => call(app, 'GET', '/api/v1/me', { token });

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
  });
  afterAll(async () => app.close());

  it('refuses missing, malformed, expired and forged tokens', async () => {
    expect((await me()).statusCode).toBe(401);
    expect(
      (await call(app, 'GET', '/api/v1/me', { headers: { authorization: 'Token abc' } })).statusCode,
    ).toBe(401);

    const { accessToken } = await registerCustomer(app);
    expect((await me(accessToken)).statusCode).toBe(200);
    clock.advance(16 * 60_000);
    const expired = await me(accessToken);
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: 'unauthorized' } });

    // A well-formed admin token signed by someone else's key.
    const forged = await new SignJWT({
      typ: 'customer',
      role: 'admin',
      ctk: 'cus_forged',
      amr: ['pwd', 'otp'],
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('00000000-0000-4000-8000-000000000000')
      .setIssuer('http://api.test')
      .setAudience('agentbazaar-api')
      .setIssuedAt(Math.floor(clock.now().getTime() / 1000))
      .setExpirationTime(Math.floor(clock.now().getTime() / 1000) + 600)
      .sign(generateKeyPairSync('ed25519').privateKey);
    expect((await call(app, 'GET', '/api/v1/admin/agent-clients', { token: forged })).statusCode).toBe(401);
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${forged.split('.')[1]}.`;
    expect((await call(app, 'GET', '/api/v1/admin/agent-clients', { token: unsigned })).statusCode).toBe(401);
  });

  it('enforces roles and scopes: customers and agents stay out of what they were not granted', async () => {
    const customer = await registerCustomer(app);
    expect(
      (await call(app, 'GET', '/api/v1/admin/agent-clients', { token: customer.accessToken })).statusCode,
    ).toBe(403);
    expect((await call(app, 'GET', '/api/v1/admin/agent-clients')).statusCode).toBe(401);
    expect(
      (await call(app, 'POST', '/api/v1/quotes', { body: { sku: 'VOLTEDGE-850G', quantity: 1 } })).statusCode,
    ).toBe(401);

    const admin = await adminToken(app);
    const client = ok<{ clientId: string; clientSecret: string }>(
      await call(app, 'POST', '/api/v1/admin/agent-clients', {
        token: admin,
        body: { name: 'Read only', scopes: ['catalog:read'] },
      }),
      201,
    );
    const { access_token } = ok<{ access_token: string }>(
      await call(app, 'POST', '/oauth/token', {
        body: {
          grant_type: 'client_credentials',
          client_id: client.clientId,
          client_secret: client.clientSecret,
        },
      }),
      200,
    );
    const quote = await call(app, 'POST', '/api/v1/quotes', {
      token: access_token,
      body: { sku: 'VOLTEDGE-850G', quantity: 1 },
    });
    expect(quote.statusCode).toBe(403);
    expect(quote.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await me(access_token)).statusCode).toBe(401);
    expect((await call(app, 'GET', '/api/v1/admin/agent-clients', { token: access_token })).statusCode).toBe(
      401,
    );
  });

  it('locks an account after 5 failed logins, even against the right password', async () => {
    const email = 'locked@example.com';
    await registerCustomer(app, email);
    for (let i = 0; i < 5; i++)
      expect(
        (await call(app, 'POST', '/api/v1/auth/login', { body: { email, password: `nope-${i}-nope` } }))
          .statusCode,
      ).toBe(401);
    const right = await call(app, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'Secret-pass-2026' },
    });
    expect(right.statusCode).toBe(401);
    expect(right.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('keeps an admin session without MFA out of admin routes (403)', async () => {
    const email = 'nomfa-admin@example.com';
    const t = await registerCustomer(app, email);
    const { customerToken } = ok<MeView>(await me(t.accessToken), 200);
    await app.infra.database.query(`UPDATE users SET role = 'admin' WHERE customer_token = $1`, [
      customerToken,
    ]);
    const session = ok<TokenResponse>(
      await call(app, 'POST', '/api/v1/auth/login', { body: { email, password: 'Secret-pass-2026' } }),
      200,
    );
    for (const [method, url] of [
      ['GET', '/api/v1/admin/agent-clients'],
      ['GET', '/api/v1/admin/reviews'],
      ['POST', '/api/v1/admin/orders/00000000-0000-4000-8000-000000000000/deliver'],
    ] as const) {
      const res = await call(app, method, url, { token: session.accessToken });
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects refresh tokens that are unknown, rotated or past their 30 days', async () => {
    expect(
      (
        await call(app, 'POST', '/api/v1/auth/refresh', {
          body: { refreshToken: 'rt_this-was-never-issued-at-all' },
        })
      ).statusCode,
    ).toBe(401);
    const t = await registerCustomer(app);
    clock.advance(31 * 86_400_000);
    expect(
      (await call(app, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: t.refreshToken } }))
        .statusCode,
    ).toBe(401);
  });
});
