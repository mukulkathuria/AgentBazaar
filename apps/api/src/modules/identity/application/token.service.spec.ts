import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadKeyRing } from '../../../shared/crypto/keyring.js';
import { ManualClock } from '../../../shared/kernel/clock.js';
import { OidcTokenVerifier, parseScopes, TokenService, toPrincipal } from './token.service.js';

const ISSUER = 'http://api.test';
const AUDIENCE = 'agentbazaar';

describe('@lite built-in token issuer', () => {
  const setup = () => {
    const clock = new ManualClock();
    const keys = loadKeyRing({});
    return { clock, keys, tokens: new TokenService(keys, ISSUER, AUDIENCE, clock) };
  };

  it('keeps only known agent scopes', () => {
    expect([...parseScopes('catalog:read  quote:create admin:all order:create')]).toEqual(['catalog:read', 'quote:create', 'order:create']);
    expect(parseScopes(undefined).size).toBe(0);
    expect(parseScopes('').size).toBe(0);
  });

  it('round-trips a customer, with MFA and role from the claims', async () => {
    const { tokens } = setup();
    const admin = await tokens.issueCustomer({ userId: 'u-1', customerToken: 'ctk-1', role: 'admin', mfa: true });
    expect(admin.expiresIn).toBe(900);
    const p = await tokens.verify(admin.accessToken);
    expect(p).toMatchObject({ kind: 'customer', subject: 'customer:ctk-1', userId: 'u-1', customerToken: 'ctk-1', role: 'admin', mfa: true });
    expect([...p.scopes].sort()).toEqual(['catalog:read', 'order:create', 'quote:create']);
    const buyer = await tokens.verify((await tokens.issueCustomer({ userId: 'u-2', customerToken: 'ctk-2', role: 'customer', mfa: false })).accessToken);
    expect(buyer).toMatchObject({ role: 'customer', mfa: false });
  });

  it('round-trips an agent client with its scopes and quota', async () => {
    const { tokens } = setup();
    const t = await tokens.issueAgent({ clientId: 'bot-1', scopes: ['catalog:read', 'quote:create'], quotaPerMinute: 120 });
    const p = await tokens.verify(t.accessToken);
    expect(p).toMatchObject({ kind: 'agent', subject: 'agent:bot-1', clientId: 'bot-1', quotaPerMinute: 120 });
    expect([...p.scopes]).toEqual(['catalog:read', 'quote:create']);
  });

  it('rejects expired, foreign and tampered tokens the same way', async () => {
    const { clock, keys, tokens } = setup();
    const t = (await tokens.issueAgent({ clientId: 'bot-1', scopes: [], quotaPerMinute: 60 })).accessToken;
    const other = new TokenService(loadKeyRing({}), ISSUER, AUDIENCE, clock);
    const wrongAudience = new TokenService(keys, ISSUER, 'someone-else', clock);
    const wrongIssuer = new TokenService(keys, 'http://elsewhere.test', AUDIENCE, clock);
    await expect(wrongIssuer.verify(t)).rejects.toMatchObject({ code: 'unauthorized' });
    for (const bad of [
      (await other.issueAgent({ clientId: 'x', scopes: [], quotaPerMinute: 1 })).accessToken,
      `${t.slice(0, -4)}AAAA`,
      'not.a.jwt',
    ]) {
      await expect(tokens.verify(bad)).rejects.toMatchObject({ code: 'unauthorized', message: 'Invalid or expired token' });
    }
    await expect(wrongAudience.verify(t)).rejects.toMatchObject({ code: 'unauthorized' });
    clock.advance(15 * 60_000);
    await expect(tokens.verify(t)).rejects.toMatchObject({ code: 'unauthorized', message: 'Invalid or expired token' });
  });

  it('maps claims to principals conservatively', () => {
    expect(() => toPrincipal({ typ: 'agent' })).toThrow('Token has no subject');
    expect(toPrincipal({ typ: 'agent', sub: 'b', qpm: 0 })).toMatchObject({ quotaPerMinute: 60 });
    expect(toPrincipal({ typ: 'agent', sub: 'b', qpm: -5 })).toMatchObject({ quotaPerMinute: 60 });
    // A customer token without its customer token, or an unknown type, is not a principal.
    expect(() => toPrincipal({ typ: 'customer', sub: 'u' })).toThrow('Unsupported token type');
    expect(() => toPrincipal({ typ: 'robot' as 'agent', sub: 'u' })).toThrow('Unsupported token type');
    // Only an explicit admin role is admin, and only an otp factor counts as MFA.
    expect(toPrincipal({ typ: 'customer', sub: 'u', ctk: 'c', role: 'owner' as 'admin' })).toMatchObject({ role: 'customer', mfa: false });
    expect(toPrincipal({ typ: 'customer', sub: 'u', ctk: 'c', amr: ['pwd'] })).toMatchObject({ mfa: false });
    expect(toPrincipal({ typ: 'customer', sub: 'u', ctk: 'c', amr: 'otp' as unknown as string[] })).toMatchObject({ mfa: false });
  });
});

describe('@growth OIDC token verifier (Keycloak claims, local key set)', () => {
  async function issuer() {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    const verifier = new OidcTokenVerifier(`${ISSUER}/realms/shop`, AUDIENCE, { keys: [jwk] });
    const sign = (claims: JWTPayload & Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer(`${ISSUER}/realms/shop`)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    return { verifier, sign };
  }

  it('maps a client-credentials token to an agent, by client_id or by azp with the agent role', async () => {
    const { verifier, sign } = await issuer();
    expect(await verifier.verify(await sign({ client_id: 'bot-7', scope: 'profile catalog:read' }))).toMatchObject({
      kind: 'agent',
      subject: 'agent:bot-7',
      clientId: 'bot-7',
      quotaPerMinute: 60,
    });
    const byRole = await verifier.verify(await sign({ azp: 'bot-8', realm_access: { roles: ['agent'] }, scope: 'quote:create' }));
    expect(byRole).toMatchObject({ kind: 'agent', clientId: 'bot-8' });
    expect([...byRole.scopes]).toEqual(['quote:create']);
  });

  it('maps a user to a customer: admin by realm role, MFA by amr or acr', async () => {
    const { verifier, sign } = await issuer();
    expect(await verifier.verify(await sign({ sub: 'kc-1', realm_access: { roles: ['admin'] }, amr: ['pwd', 'otp'] }))).toMatchObject({
      kind: 'customer',
      subject: 'customer:oidc_kc-1',
      userId: 'kc-1',
      customerToken: 'oidc_kc-1',
      role: 'admin',
      mfa: true,
    });
    expect(await verifier.verify(await sign({ sub: 'kc-2', amr: ['mfa'] }))).toMatchObject({ role: 'customer', mfa: true });
    expect(await verifier.verify(await sign({ sub: 'kc-3', acr: 'mfa' }))).toMatchObject({ mfa: true });
    expect(await verifier.verify(await sign({ sub: 'kc-4', acr: '1', amr: ['pwd'] }))).toMatchObject({ mfa: false });
    // azp alone does not make an agent: users carry it too.
    expect(await verifier.verify(await sign({ sub: 'kc-5', azp: 'storefront', realm_access: { roles: ['user'] } }))).toMatchObject({
      kind: 'customer',
      userId: 'kc-5',
    });
  });

  it('refuses tokens without a subject or from another issuer', async () => {
    const { verifier, sign } = await issuer();
    await expect(verifier.verify(await sign({ realm_access: { roles: ['agent'] } }))).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Token has no subject',
    });
    const stranger = await issuer();
    await expect(verifier.verify(await stranger.sign({ sub: 'kc-9' }))).rejects.toMatchObject({ message: 'Invalid or expired token' });
  });

  it('fetches keys from the issuer when none are given, and fails closed when it is unreachable', async () => {
    const verifier = new OidcTokenVerifier('http://127.0.0.1:9/realms/shop/', AUDIENCE);
    const { sign } = await issuer();
    await expect(verifier.verify(await sign({ sub: 'kc-1' }))).rejects.toMatchObject({ code: 'unauthorized', message: 'Invalid or expired token' });
  });
});
