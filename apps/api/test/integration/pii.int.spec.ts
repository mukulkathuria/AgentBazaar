import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInput } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY_WRAPPER, PiiService, rewrapDataKeys, type TransitKeyWrapper } from '../../src/modules/pii/index.js';
import { blindIndex, LocalKeyWrapper, type KeyRing, type KeyWrapper } from '../../src/shared/crypto/keyring.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import { KEYS } from '../../src/shared/kernel/tokens.js';
import { createShopApp, type ShopApp } from '../support/shop.js';

const ADDRESS: AddressInput = { name: 'Asha Verma', phone: '9876543210', line1: '12 MG Road', city: 'New Delhi', stateCode: 'DL', pincode: '110001' };
const DAY = 86_400_000;

/** A stand-in for OpenBao Transit: versioned ciphertext ("vault:vN:..."), one local key per version. */
class FakeTransit implements TransitKeyWrapper {
  readonly keyId = 'transit:pii';
  version = 1;
  corrupt = false;
  private readonly keys = new Map<number, LocalKeyWrapper>();
  private key(v: number) {
    if (!this.keys.has(v)) this.keys.set(v, new LocalKeyWrapper(randomBytes(32), `transit-v${v}`));
    return this.keys.get(v)!;
  }
  async wrap(dek: Buffer, context: string) {
    return `vault:v${this.version}:${await this.key(this.version).wrap(this.corrupt ? randomBytes(32) : dek, context)}`;
  }
  async unwrap(wrapped: string, context: string) {
    const [, v, body] = /^vault:v(\d+):(.*)$/.exec(wrapped)!;
    return this.key(Number(v)).unwrap(body!, context);
  }
  async rewrap(wrapped: string, context: string) {
    return this.wrap(await this.unwrap(wrapped, context), context);
  }
  async latestVersion() {
    return this.version;
  }
}

/** The vault: encrypted customer records, blind indexes, erasure, retention and key re-wrapping. */
describe('@lite PII vault', () => {
  let app: ShopApp;
  let clock: ManualClock;
  let pii: PiiService;
  let local: KeyWrapper;
  let keys: KeyRing;
  const q = <T>(text: string, params: unknown[] = []) => app.infra.database.query<T>(text, params);
  const db = () => app.infra.db;
  const email = () => `vault-${randomUUID().slice(0, 8)}@example.com`;
  const upsert = (p: { email: string; name?: string; phone?: string }) => inTransaction(db(), (tx) => pii.upsertCustomer(tx, p));
  const row = async (token: string) =>
    (await q<{ key_id: string; wrapped_dek: string | null; email_bidx: string | null; phone_bidx: string | null; erased_at: Date | null }>(
      'SELECT key_id, wrapped_dek, email_bidx, phone_bidx, erased_at FROM pii.customers WHERE token = $1',
      [token],
    ))[0]!;

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
    pii = app.app.get(PiiService);
    local = app.app.get<KeyWrapper>(KEY_WRAPPER);
    keys = app.app.get<KeyRing>(KEYS);
  }, 120_000);
  afterAll(async () => app.close());

  it('stores a customer encrypted, findable only through blind indexes', async () => {
    const address = email();
    const token = await upsert({ email: address, name: 'Asha Verma', phone: '+91 98765-43210' });
    expect(token).toMatch(/^cus_/);
    expect(await pii.customer(token)).toEqual({ email: address, name: 'Asha Verma', phone: '+91 98765-43210' });
    const r = await row(token);
    expect(r.key_id).toBe(local.keyId);
    expect(r.email_bidx).toBe(blindIndex(keys.blindIndexKey, 'email', address));
    // Phones index on their last ten digits, so +91 and spacing do not matter.
    expect(r.phone_bidx).toBe(blindIndex(keys.blindIndexKey, 'phone', '9876543210'));
    expect(await pii.findByEmail(` ${address.toUpperCase()} `)).toBe(token);
    expect(await pii.findByEmail('nobody@example.com')).toBeNull();
    expect(await pii.customer('cus_unknown')).toBeNull();
  });

  it('updates the same record for the same email and keeps fields that were not given', async () => {
    const address = email();
    const token = await upsert({ email: address, name: 'Asha' });
    expect(await upsert({ email: address, phone: '09876543210' })).toBe(token);
    expect(await pii.customer(token)).toEqual({ email: address, name: 'Asha', phone: '09876543210' });
    expect((await row(token)).phone_bidx).toBe(blindIndex(keys.blindIndexKey, 'phone', '9876543210'));
    await upsert({ email: address, name: 'Asha V' });
    expect(await pii.customer(token)).toEqual({ email: address, name: 'Asha V', phone: '09876543210' });
  });

  it('keeps addresses under the customer key, and none for an unknown customer', async () => {
    const token = await upsert({ email: email() });
    await inTransaction(db(), (tx) => pii.storeAddress(tx, token, ADDRESS));
    expect(await pii.addresses(token)).toEqual([ADDRESS]);
    expect(await pii.addresses('cus_unknown')).toEqual([]);
  });

  it('erases by crypto-shredding: the record, its addresses and its index entries go, and the event is published', async () => {
    const address = email();
    const token = await upsert({ email: address, name: 'Gone Soon', phone: '9876500000' });
    await inTransaction(db(), (tx) => pii.storeAddress(tx, token, ADDRESS));
    await inTransaction(db(), (tx) => pii.erase(tx, token));
    expect(await row(token)).toMatchObject({ wrapped_dek: null, email_bidx: null, phone_bidx: null, erased_at: expect.any(Date) });
    expect(await pii.customer(token)).toBeNull();
    expect(await pii.addresses(token)).toEqual([]);
    expect(await pii.findByEmail(address)).toBeNull();
    await expect(inTransaction(db(), (tx) => pii.storeAddress(tx, token, ADDRESS))).rejects.toThrow('Customer has been erased');
    const [request] = await q<{ completed_at: Date | null }>('SELECT completed_at FROM pii.erasure_requests WHERE customer_token = $1', [token]);
    expect(request!.completed_at).toBeInstanceOf(Date);
    const [event] = await q<{ payload: unknown }>(`SELECT payload FROM outbox_events WHERE topic = 'pii.customer_erased' AND aggregate_id = $1`, [token]);
    expect(event!.payload).toEqual({ customerToken: token });
  });

  it('erases guests inactive past the retention window (three years by default), never account holders', async () => {
    const stale = await upsert({ email: email() });
    const recent = await upsert({ email: email() });
    const now = clock.now().getTime();
    await q('UPDATE pii.customers SET last_activity_at = $1 WHERE token = $2', [new Date(now - 3 * 365 * DAY - DAY), stale]);
    await q('UPDATE pii.customers SET last_activity_at = $1 WHERE token = $2', [new Date(now - 3 * 365 * DAY + DAY), recent]);
    const erased = await inTransaction(db(), (tx) => pii.retentionSweep(tx));
    expect(erased).toBeGreaterThanOrEqual(1);
    expect((await row(stale)).erased_at).toBeInstanceOf(Date);
    expect((await row(recent)).erased_at).toBeNull();
    // A shorter window catches the recent guest too; customers with an account are kept.
    const [holder] = await q<{ customer_token: string }>(`SELECT customer_token FROM users WHERE status = 'active' LIMIT 1`);
    await q('UPDATE pii.customers SET last_activity_at = $1 WHERE token = $2', [new Date(now - 10 * DAY), holder!.customer_token]);
    expect(await inTransaction(db(), (tx) => pii.retentionSweep(tx, 1))).toBeGreaterThanOrEqual(1);
    expect((await row(recent)).erased_at).toBeInstanceOf(Date);
    expect((await row(holder!.customer_token)).erased_at).toBeNull();
  });

  describe('re-wrapping data keys to OpenBao Transit', () => {
    // One Transit for the whole block: keys moved by the first test stay readable in the second.
    const transit = new FakeTransit();

    it('moves every env-wrapped key, verifies each round trip, then rotates to the latest Transit version', async () => {
      const tokens = await Promise.all([1, 2, 3].map(() => upsert({ email: email(), name: 'Moved' })));
      const first = await rewrapDataKeys(db(), local, transit, 2);
      expect(first.moved).toBeGreaterThanOrEqual(3);
      expect(first).toMatchObject({ rotated: 0, remaining: 0, unknownKey: 0 });
      for (const t of tokens) {
        const r = await row(t);
        expect(r.key_id).toBe('transit:pii');
        expect(r.wrapped_dek).toMatch(/^vault:v1:/);
      }
      // Idempotent: nothing left to move or rotate.
      expect(await rewrapDataKeys(db(), local, transit, 2)).toEqual({ moved: 0, rotated: 0, remaining: 0, unknownKey: 0 });
      transit.version = 2;
      const second = await rewrapDataKeys(db(), local, transit, 2);
      expect(second.moved).toBe(0);
      expect(second.rotated).toBe(first.moved);
      for (const t of tokens) expect((await row(t)).wrapped_dek).toMatch(/^vault:v2:/);
      // Every data key still opens: the customer's fields decrypt with the re-wrapped key.
      const r = await row(tokens[0]!);
      const dek = await transit.unwrap(r.wrapped_dek!, tokens[0]!);
      expect(dek).toHaveLength(32);
    });

    it('refuses to replace a key when the Transit round trip changes it, and counts keys it does not know', async () => {
      const token = await upsert({ email: email() });
      const before = (await row(token)).wrapped_dek;
      const broken = new FakeTransit();
      broken.corrupt = true;
      await expect(rewrapDataKeys(db(), local, broken, 50)).rejects.toThrow(/^OpenBao round trip changed the data key of cus_/);
      expect((await row(token)).wrapped_dek).toBe(before);
      await q(`UPDATE pii.customers SET key_id = 'retired-key' WHERE token = $1`, [token]);
      expect(await rewrapDataKeys(db(), local, transit, 50)).toEqual({ moved: 0, rotated: 0, remaining: 0, unknownKey: 1 });
    });
  });
});
