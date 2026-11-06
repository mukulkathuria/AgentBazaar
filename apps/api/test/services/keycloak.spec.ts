import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OidcTokenVerifier } from '../../src/modules/identity/application/token.service.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

// Needs Keycloak with the realm in keycloak/ (see keycloak/docker-compose.yml and .github/workflows/keycloak.yml);
// skipped in the shared services run, which has no Keycloak.
const KC = process.env.KEYCLOAK_URL;
const REALM = 't6-agentbazaar';
const ISSUER = `${KC}/realms/${REALM}`;
const AUDIENCE = 'agentbazaar-api';
const SECRET = (client: string) => `ci-only-${client.replace(/^t6-/, '')}-secret`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64url = (s: string) => Buffer.from(s).toString('base64url');

async function tokenFrom(realm: string, form: Record<string, string>): Promise<string> {
  const res = await fetch(`${KC}/realms/${realm}/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams(form) });
  const json = (await res.json()) as { access_token?: string };
  if (!res.ok || !json.access_token) throw new Error(`token from ${realm}: ${res.status} ${JSON.stringify(json)}`);
  return json.access_token;
}

const personToken = (username: string) =>
  tokenFrom(REALM, { grant_type: 'password', client_id: 't6-storefront', username, password: `ci-only-${username.slice(3)}-password` });
const agentToken = (client: string) =>
  tokenFrom(REALM, { grant_type: 'client_credentials', client_id: client, client_secret: SECRET(client) });

async function adminApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await tokenFrom('master', {
    grant_type: 'password',
    client_id: 'admin-cli',
    username: process.env.KEYCLOAK_ADMIN_USER ?? 'ci-admin',
    password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'ci-only-keycloak-admin',
  });
  const res = await fetch(`${KC}/admin/realms/${REALM}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 200 ? await res.json() : undefined) as T;
}

/** The agent scopes are Keycloak client scopes; a realm import that defined them would drop the built-in ones. */
async function attachAgentScopes(): Promise<void> {
  for (const name of ['catalog:read', 'quote:create', 'order:create']) {
    await adminApi('POST', '/client-scopes', {
      name,
      protocol: 'openid-connect',
      attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
    });
  }
  const scopes = await adminApi<{ id: string; name: string }[]>('GET', '/client-scopes');
  const grants: Record<string, string[]> = { 't6-buyer-agent': ['catalog:read', 'quote:create'], 't6-reader-agent': ['catalog:read'] };
  for (const [clientId, names] of Object.entries(grants)) {
    const [client] = await adminApi<{ id: string }[]>('GET', `/clients?clientId=${clientId}`);
    for (const n of names) await adminApi('PUT', `/clients/${client!.id}/default-client-scopes/${scopes.find((s) => s.name === n)!.id}`);
  }
}

describe.skipIf(!KC)('Keycloak-issued tokens @growth', () => {
  let app: TestApp;
  const call = (method: 'GET' | 'POST', url: string, token?: string) =>
    app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    await attachAgentScopes();
    app = await createTestApp({ IDENTITY_PROVIDER: 'oidc', OIDC_ISSUER_URL: ISSUER, OIDC_AUDIENCE: AUDIENCE });
  });
  afterAll(() => app?.close());

  it('maps a signed-in person to a customer, and the admin realm role to admin', async () => {
    const buyer = await personToken('t6-buyer');
    const me = await call('GET', '/api/v1/me', buyer);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ customerToken: `oidc_${decodeJwt(buyer).sub}`, role: 'customer' });

    const admin = await personToken('t6-admin');
    expect((await call('GET', '/api/v1/me', admin)).json()).toMatchObject({ role: 'admin' });
    // Admin routes also need MFA, which a password-only Keycloak session does not carry.
    const adminRoute = await call('GET', '/api/v1/admin/agent-clients', admin);
    expect([adminRoute.statusCode, adminRoute.json().error.message]).toEqual([403, 'Admin access needs a session verified with MFA']);
    const buyerRoute = await call('GET', '/api/v1/admin/agent-clients', buyer);
    expect([buyerRoute.statusCode, buyerRoute.json().error.message]).toEqual([403, 'Admins only']);
  });

  it('maps a client-credentials token to an agent with exactly its Keycloak scopes', async () => {
    const token = await agentToken('t6-buyer-agent');
    const agent = await new OidcTokenVerifier(ISSUER, AUDIENCE).verify(token);
    expect(agent).toMatchObject({ kind: 'agent', clientId: 't6-buyer-agent', subject: 'agent:t6-buyer-agent' });
    expect([...agent.scopes].sort()).toEqual(['catalog:read', 'quote:create']);
    // Past the scope check, the empty body fails validation.
    expect((await call('POST', '/api/v1/quotes', token)).statusCode).toBe(400);

    const reader = await call('POST', '/api/v1/quotes', await agentToken('t6-reader-agent'));
    expect([reader.statusCode, reader.json().error.message]).toEqual([403, 'Token is missing the "quote:create" scope']);
    expect((await call('POST', '/api/v1/quotes')).statusCode).toBe(401);
  });

  it('rejects a token for another audience, an expired token and a tampered token', async () => {
    const verifier = new OidcTokenVerifier(ISSUER, AUDIENCE);
    const unauthorized = { code: 'unauthorized' };

    const other = await agentToken('t6-other-app');
    expect(decodeJwt(other).aud).toContain('some-other-api');
    await expect(verifier.verify(other)).rejects.toMatchObject(unauthorized);
    expect((await call('POST', '/api/v1/quotes', other)).statusCode).toBe(401);

    const short = await agentToken('t6-short-lived'); // lives two seconds
    await expect(verifier.verify(short)).resolves.toMatchObject({ kind: 'agent', clientId: 't6-short-lived' });
    await sleep(3500);
    await expect(verifier.verify(short)).rejects.toMatchObject(unauthorized);

    const real = await agentToken('t6-reader-agent');
    const [header, payload, signature] = real.split('.');
    const widened = b64url(JSON.stringify({ ...decodeJwt(real), scope: 'catalog:read quote:create order:create' }));
    const forged = `${header}.${widened}.${signature}`;
    await expect(verifier.verify(forged)).rejects.toMatchObject(unauthorized);
    await expect(verifier.verify(`${b64url('{"alg":"none","typ":"JWT"}')}.${payload}.`)).rejects.toMatchObject(unauthorized);
    expect((await call('POST', '/api/v1/quotes', forged)).statusCode).toBe(401);
  });

  it('accepts tokens signed with a rotated realm key, fetched from the JWKS', async () => {
    const verifier = new OidcTokenVerifier(ISSUER, AUDIENCE);
    const before = await agentToken('t6-buyer-agent');
    await verifier.verify(before); // the verifier now holds the realm's current keys
    await adminApi('POST', '/components', {
      name: `t6-rotated-${Date.now()}`,
      providerId: 'rsa-generated',
      providerType: 'org.keycloak.keys.KeyProvider',
      parentId: REALM,
      config: { priority: ['1000'], enabled: ['true'], active: ['true'], algorithm: ['RS256'], keySize: ['2048'] },
    });
    const after = await agentToken('t6-buyer-agent');
    expect(decodeProtectedHeader(after).kid).not.toBe(decodeProtectedHeader(before).kid);
    // jose re-reads the JWKS for an unknown key id, at most once per 30-second cooldown.
    await sleep(31_000);
    await expect(verifier.verify(after)).resolves.toMatchObject({ kind: 'agent', clientId: 't6-buyer-agent' });
    await expect(verifier.verify(before)).resolves.toMatchObject({ kind: 'agent' }); // the old key is still published
  }, 90_000);
});
