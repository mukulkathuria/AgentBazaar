import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AddressInput, ConsentPurpose, ConsentView } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import { blindIndex, type KeyRing, type KeyWrapper } from '../../../shared/crypto/keyring.js';
import { aeadDecrypt, aeadEncrypt, randomToken } from '../../../shared/crypto/primitives.js';
import { one, rows, type Executor } from '../../../shared/db/database.js';
import type { Clock } from '../../../shared/kernel/clock.js';
import { CLOCK, DB, KEYS } from '../../../shared/kernel/tokens.js';
import { appendEvent } from '../../../shared/outbox/outbox.js';

export const KEY_WRAPPER = Symbol('KEY_WRAPPER');
/** Version of the privacy notice the customer saw. Bump it when the notice text changes. */
export const NOTICE_VERSION = '2026-11-v1';

export interface CustomerPii {
  email: string | null;
  name: string | null;
  phone: string | null;
}

const normPhone = (p: string) => p.replace(/\D/g, '').slice(-10);

/**
 * The only code that sees personal data. Other modules hold opaque tokens. Each customer has a data
 * key wrapped by the master key; erasing the wrapped key makes all of their ciphertext unreadable.
 */
@Injectable()
export class PiiService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(KEYS) private readonly keys: KeyRing,
    @Inject(KEY_WRAPPER) private readonly wrapper: KeyWrapper,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private bidx(kind: 'email' | 'phone', v: string): string {
    return blindIndex(this.keys.blindIndexKey, kind, kind === 'phone' ? normPhone(v) : v);
  }

  private async dek(ex: Executor, token: string): Promise<Buffer | null> {
    const r = await one<{ wrapped_dek: string | null }>(ex, sql`SELECT wrapped_dek FROM pii.customers WHERE token = ${token}`);
    return r?.wrapped_dek ? this.wrapper.unwrap(r.wrapped_dek, token) : null;
  }

  private enc(dek: Buffer, token: string, field: string, v: string | undefined | null): string | null {
    return v ? aeadEncrypt(dek, v, `${token}:${field}`) : null;
  }

  private dec(dek: Buffer, token: string, field: string, v: string | null): string | null {
    return v ? aeadDecrypt(dek, v, `${token}:${field}`).toString('utf8') : null;
  }

  async findByEmail(email: string, ex: Executor = this.db): Promise<string | null> {
    const r = await one<{ token: string }>(ex, sql`SELECT token FROM pii.customers WHERE email_bidx = ${this.bidx('email', email)} AND erased_at IS NULL`);
    return r?.token ?? null;
  }

  async upsertCustomer(tx: Executor, p: { email: string; name?: string | undefined; phone?: string | undefined }): Promise<string> {
    const emailIdx = this.bidx('email', p.email);
    const existing = await one<{ token: string; wrapped_dek: string | null }>(
      tx,
      sql`SELECT token, wrapped_dek FROM pii.customers WHERE email_bidx = ${emailIdx} FOR UPDATE`,
    );
    if (existing?.wrapped_dek) {
      const dek = await this.wrapper.unwrap(existing.wrapped_dek, existing.token);
      await tx.execute(
        sql`UPDATE pii.customers SET
              name_enc = COALESCE(${this.enc(dek, existing.token, 'name', p.name)}, name_enc),
              phone_enc = COALESCE(${this.enc(dek, existing.token, 'phone', p.phone)}, phone_enc),
              phone_bidx = COALESCE(${p.phone ? this.bidx('phone', p.phone) : null}, phone_bidx),
              last_activity_at = now()
            WHERE token = ${existing.token}`,
      );
      return existing.token;
    }
    const token = `cus_${randomToken(18)}`;
    const dek = randomBytes(32);
    await tx.execute(
      sql`INSERT INTO pii.customers (token, wrapped_dek, key_id, email_enc, email_bidx, phone_enc, phone_bidx, name_enc)
          VALUES (${token}, ${await this.wrapper.wrap(dek, token)}, ${this.wrapper.keyId}, ${this.enc(dek, token, 'email', p.email)},
                  ${emailIdx}, ${this.enc(dek, token, 'phone', p.phone)}, ${p.phone ? this.bidx('phone', p.phone) : null},
                  ${this.enc(dek, token, 'name', p.name)})`,
    );
    return token;
  }

  async storeAddress(tx: Executor, customerToken: string, address: AddressInput): Promise<string> {
    const dek = await this.dek(tx, customerToken);
    if (!dek) throw new Error('Customer has been erased');
    const token = `adr_${randomToken(18)}`;
    await tx.execute(
      sql`INSERT INTO pii.addresses (token, customer_token, data_enc, state_code)
          VALUES (${token}, ${customerToken}, ${aeadEncrypt(dek, JSON.stringify(address), `${customerToken}:address:${token}`)}, ${address.stateCode})`,
    );
    return token;
  }

  async customer(token: string, ex: Executor = this.db): Promise<CustomerPii | null> {
    const r = await one<{ wrapped_dek: string | null; email_enc: string | null; name_enc: string | null; phone_enc: string | null }>(
      ex,
      sql`SELECT wrapped_dek, email_enc, name_enc, phone_enc FROM pii.customers WHERE token = ${token}`,
    );
    if (!r?.wrapped_dek) return null;
    const dek = await this.wrapper.unwrap(r.wrapped_dek, token);
    return { email: this.dec(dek, token, 'email', r.email_enc), name: this.dec(dek, token, 'name', r.name_enc), phone: this.dec(dek, token, 'phone', r.phone_enc) };
  }

  async addresses(customerToken: string, ex: Executor = this.db): Promise<AddressInput[]> {
    const dek = await this.dek(ex, customerToken);
    if (!dek) return [];
    const r = await rows<{ token: string; data_enc: string }>(ex, sql`SELECT token, data_enc FROM pii.addresses WHERE customer_token = ${customerToken}`);
    return r.map((a) => JSON.parse(aeadDecrypt(dek, a.data_enc, `${customerToken}:address:${a.token}`).toString('utf8')) as AddressInput);
  }

  async recordConsent(tx: Executor, token: string, purpose: ConsentPurpose, granted: boolean, source: string): Promise<void> {
    await tx.execute(
      sql`INSERT INTO pii.consents (customer_token, purpose, granted, notice_version, source)
          VALUES (${token}, ${purpose}, ${granted}, ${NOTICE_VERSION}, ${source})`,
    );
  }

  async consents(token: string, ex: Executor = this.db): Promise<ConsentView[]> {
    const r = await rows<{ purpose: ConsentPurpose; granted: boolean; notice_version: string; created_at: Date }>(
      ex,
      sql`SELECT DISTINCT ON (purpose) purpose, granted, notice_version, created_at FROM pii.consents
          WHERE customer_token = ${token} ORDER BY purpose, id DESC`,
    );
    return r.map((c) => ({ purpose: c.purpose, granted: c.granted, noticeVersion: c.notice_version, at: c.created_at.toISOString() }));
  }

  /** DPDP data export: everything we hold about the person, decrypted. */
  async export(token: string): Promise<Record<string, unknown>> {
    return { customer: await this.customer(token), addresses: await this.addresses(token), consents: await this.consents(token) };
  }

  /** DPDP erasure by crypto-shredding: the wrapped key and every encrypted field are deleted. */
  async erase(tx: Executor, token: string): Promise<void> {
    await tx.execute(sql`INSERT INTO pii.erasure_requests (customer_token) VALUES (${token})`);
    await tx.execute(sql`DELETE FROM pii.addresses WHERE customer_token = ${token}`);
    await tx.execute(
      sql`UPDATE pii.customers SET wrapped_dek = NULL, email_enc = NULL, email_bidx = NULL, phone_enc = NULL, phone_bidx = NULL,
            name_enc = NULL, erased_at = now() WHERE token = ${token}`,
    );
    await tx.execute(sql`UPDATE pii.erasure_requests SET completed_at = now() WHERE customer_token = ${token} AND completed_at IS NULL`);
    await appendEvent(tx, 'pii.customer_erased', token, { customerToken: token });
  }

  /** Retention: erase guest customers inactive for longer than the retention window. */
  async retentionSweep(tx: Executor, retentionDays = 3 * 365): Promise<number> {
    const due = await rows<{ token: string }>(
      tx,
      sql`SELECT c.token FROM pii.customers c WHERE c.erased_at IS NULL
          AND c.last_activity_at < ${this.clock.now()}::timestamptz - (${retentionDays} * interval '1 day')
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.customer_token = c.token AND u.status = 'active') LIMIT 200`,
    );
    for (const d of due) await this.erase(tx, d.token);
    return due.length;
  }
}
