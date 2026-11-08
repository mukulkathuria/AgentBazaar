import { randomUUID } from 'node:crypto';
import type { RegisterInput } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountService, type CustomerPrincipal } from '../../src/modules/identity/application/account.service.js';
import { TokenService } from '../../src/modules/identity/index.js';
import { PiiService } from '../../src/modules/pii/index.js';
import { totp } from '../../src/shared/crypto/primitives.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import { createShopApp, type ShopApp } from '../support/shop.js';

const MINUTE = 60_000;

/** Accounts against a seeded shop: registration, lockout, refresh rotation, MFA, admins, erasure. */
describe('@lite account service', () => {
  let app: ShopApp;
  let clock: ManualClock;
  let accounts: AccountService;
  const q = <T>(text: string, params: unknown[] = []) => app.infra.database.query<T>(text, params);
  const email = () => `buyer-${randomUUID().slice(0, 8)}@example.com`;
  const register = (address: string, over: Partial<RegisterInput> = {}) =>
    accounts.register({ email: address, password: 'Correct-horse-9', name: 'Asha Verma', consents: { terms: true, marketing: false }, ...over });
  const principal = async (accessToken: string) => (await app.app.get(TokenService).verify(accessToken)) as CustomerPrincipal;
  const audit = (action: string) => q<{ actor: string; target: string }>('SELECT actor, target FROM audit_log WHERE action = $1 ORDER BY id', [action]);

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
    accounts = app.app.get(AccountService);
  }, 120_000);
  afterAll(async () => app.close());

  it('registers a customer with a session, the vault record and the consents given', async () => {
    const address = email();
    const s = await register(address, { consents: { terms: true, marketing: true } });
    expect(s).toMatchObject({ tokenType: 'Bearer', role: 'customer', expiresIn: 900 });
    expect(s.refreshToken).toMatch(/^rt_/);
    const who = await principal(s.accessToken);
    expect(who).toMatchObject({ kind: 'customer', role: 'customer', mfa: false });
    const me = await accounts.me(who);
    expect(me).toMatchObject({ customerToken: who.customerToken, role: 'customer', name: 'Asha Verma', email: address, mfaEnabled: false });
    expect(me.consents.map((c) => [c.purpose, c.granted])).toEqual([
      ['marketing', true],
      ['terms', true],
    ]);
    const [source] = await q<{ source: string }>(`SELECT source FROM pii.consents WHERE customer_token = $1 AND purpose = 'terms'`, [who.customerToken]);
    expect(source!.source).toBe('register');
  });

  it('refuses a second account for the same email, however it is typed', async () => {
    const address = email();
    await register(address);
    await expect(register(`  ${address.toUpperCase()} `)).rejects.toMatchObject({
      code: 'conflict',
      message: 'An account already exists for this email. Sign in instead.',
    });
  });

  it('turns a unique violation from a concurrent registration into the same conflict, and passes other errors on', async () => {
    const pii = app.app.get(PiiService);
    const raced = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const wrapped = new Error('Failed query', { cause: { code: '23505' } });
    const other = Object.assign(new Error('could not serialize access'), { code: '40001' });
    for (const failure of [raced, wrapped]) {
      vi.spyOn(pii, 'upsertCustomer').mockRejectedValueOnce(failure);
      await expect(register(email())).rejects.toMatchObject({ code: 'conflict', message: 'An account already exists for this email. Sign in instead.' });
    }
    vi.spyOn(pii, 'upsertCustomer').mockRejectedValueOnce(other);
    await expect(register(email())).rejects.toBe(other);
    vi.restoreAllMocks();
  });

  it('locks an account for 15 minutes after five failed sign-ins, with one message for every failure', async () => {
    const address = email();
    await register(address);
    const invalid = { code: 'unauthorized', message: 'Email or password is incorrect, or the account is temporarily locked' };
    await expect(accounts.login({ email: 'nobody@example.com', password: 'whatever-1' })).rejects.toMatchObject(invalid);
    for (let i = 0; i < 5; i++) await expect(accounts.login({ email: address, password: 'wrong-password-1' })).rejects.toMatchObject(invalid);
    // Locked: even the right password fails until the lock runs out, and works from that instant.
    await expect(accounts.login({ email: address, password: 'Correct-horse-9' })).rejects.toMatchObject(invalid);
    clock.advance(15 * MINUTE - 1);
    await expect(accounts.login({ email: address, password: 'Correct-horse-9' })).rejects.toMatchObject(invalid);
    clock.advance(1);
    const signedIn = await accounts.login({ email: address, password: 'Correct-horse-9' });
    expect(signedIn.role).toBe('customer');
    // A successful sign-in clears the counter, so the next failure does not lock again at once.
    const who = await principal(signedIn.accessToken);
    const [u] = await q<{ failed_logins: number; locked_until: Date | null }>('SELECT failed_logins, locked_until FROM users WHERE customer_token = $1', [
      who.customerToken,
    ]);
    expect(u).toEqual({ failed_logins: 0, locked_until: null });
  });

  it('rotates refresh tokens, ends every session when a used one comes back, and expires them after 30 days', async () => {
    const s = await register(email());
    const rotated = await accounts.refresh(s.refreshToken!);
    expect(rotated.refreshToken).not.toBe(s.refreshToken);
    const ended = { code: 'unauthorized', message: 'Your session has ended. Sign in again.' };
    await expect(accounts.refresh(s.refreshToken!)).rejects.toMatchObject(ended);
    // The reuse revoked the rotated token too, and was audited against the user.
    await expect(accounts.refresh(rotated.refreshToken!)).rejects.toMatchObject(ended);
    const who = await principal(s.accessToken);
    const [user] = await q<{ id: string }>('SELECT id FROM users WHERE customer_token = $1', [who.customerToken]);
    expect(await audit('identity.refresh_token_reused')).toContainEqual({ actor: 'system', target: user!.id });

    const later = await register(email());
    clock.advance(30 * 24 * 60 * MINUTE - 1);
    const kept = await accounts.refresh(later.refreshToken!);
    clock.advance(30 * 24 * 60 * MINUTE);
    await expect(accounts.refresh(kept.refreshToken!)).rejects.toMatchObject(ended);
    await expect(accounts.refresh('rt_unknown')).rejects.toMatchObject(ended);
  });

  it('enrols two-factor sign-in once, checks the code, and then requires it to sign in', async () => {
    const address = email();
    const who = await principal((await register(address)).accessToken);
    await expect(accounts.mfaVerify(who, '123456')).rejects.toMatchObject({ code: 'conflict', message: 'Start two-factor setup first' });
    const { secret, otpauthUrl } = await accounts.mfaSetup(who);
    expect(otpauthUrl).toBe(`otpauth://totp/AgentBazaar:account?secret=${secret}&issuer=AgentBazaar&algorithm=SHA1&digits=6&period=30`);
    const wrong = totp(secret, new Date(clock.now().getTime() + 10 * MINUTE));
    await expect(accounts.mfaVerify(who, wrong)).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'That code is not valid. Check the time on your device and try again.',
    });
    await accounts.mfaVerify(who, totp(secret, clock.now()));
    expect((await accounts.me(who)).mfaEnabled).toBe(true);
    const [user] = await q<{ id: string }>('SELECT id FROM users WHERE customer_token = $1', [who.customerToken]);
    expect(await audit('identity.mfa_enabled')).toContainEqual({ actor: who.subject, target: user!.id });
    await expect(accounts.mfaSetup(who)).rejects.toMatchObject({ code: 'conflict', message: 'Two-factor sign-in is already enabled' });

    await expect(accounts.login({ email: address, password: 'Correct-horse-9' })).rejects.toMatchObject({ code: 'unauthorized' });
    const s = await accounts.login({ email: address, password: 'Correct-horse-9', totp: totp(secret, clock.now()) });
    expect((await principal(s.accessToken)).mfa).toBe(true);
    // A refresh keeps the MFA level of the account.
    expect((await principal((await accounts.refresh(s.refreshToken!)).accessToken)).mfa).toBe(true);
  });

  it('records consent changes from the account page', async () => {
    const who = await principal((await register(email())).accessToken);
    const me = await accounts.updateConsent(who, 'analytics', true);
    expect(me.consents.find((c) => c.purpose === 'analytics')).toMatchObject({ granted: true });
    const [row] = await q<{ source: string }>(`SELECT source FROM pii.consents WHERE customer_token = $1 AND purpose = 'analytics'`, [who.customerToken]);
    expect(row!.source).toBe('account');
  });

  it('creates admins with MFA on, a default name and an audit entry, once per email', async () => {
    const address = email();
    const { userId, totpSecret } = await accounts.createAdmin({ email: address, password: 'Admin-pass-2026' });
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    const s = await accounts.login({ email: address, password: 'Admin-pass-2026', totp: totp(totpSecret, clock.now()) });
    const who = await principal(s.accessToken);
    expect(who).toMatchObject({ role: 'admin', mfa: true });
    expect(await accounts.me(who)).toMatchObject({ name: 'Store admin', mfaEnabled: true });
    expect(await audit('identity.admin_created')).toContainEqual({ actor: 'cli', target: userId });
    await expect(accounts.createAdmin({ email: address, password: 'Admin-pass-2026', name: 'Other' })).rejects.toMatchObject({
      code: 'conflict',
      message: 'An account already exists for this email',
    });
    const named = await accounts.createAdmin({ email: email(), password: 'Admin-pass-2026', name: 'Ravi Ops' });
    const [n] = await q<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE id = $1', [named.userId]);
    expect(n!.n).toBe(1);
  });

  it('exports what it holds and erases the account so it can no longer act', async () => {
    const address = email();
    const s = await register(address);
    const who = await principal(s.accessToken);
    const data = await accounts.exportData(who);
    expect(data).toMatchObject({ account: { role: 'customer', mfaEnabled: false }, customer: { email: address, name: 'Asha Verma' }, orders: [] });
    await accounts.erase(who);
    expect(await accounts.me(who)).toMatchObject({ name: null, email: null, mfaEnabled: false });
    expect((await accounts.exportData(who)).account).toBeNull();
    await expect(accounts.mfaSetup(who)).rejects.toMatchObject({ code: 'not_found', message: 'Account not found' });
    await expect(accounts.refresh(s.refreshToken!)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(accounts.login({ email: address, password: 'Correct-horse-9' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await audit('identity.erased')).toContainEqual({ actor: who.subject, target: who.customerToken });
  });
});
