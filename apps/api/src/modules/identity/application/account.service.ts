import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ConsentPurpose,
  LoginInput,
  MeView,
  RegisterInput,
  Role,
  TokenResponse,
} from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import { blindIndex, type KeyRing } from '../../../shared/crypto/keyring.js';
import {
  aeadDecrypt,
  aeadEncrypt,
  hashPassword,
  newTotpSecret,
  randomToken,
  sha256Hex,
  verifyPassword,
  verifyTotp,
} from '../../../shared/crypto/primitives.js';
import { inTransaction, one, type Executor } from '../../../shared/db/database.js';
import type { Principal } from '../../../shared/http/auth.js';
import { addSeconds, type Clock } from '../../../shared/kernel/clock.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { CLOCK, DB, KEYS } from '../../../shared/kernel/tokens.js';
import { AuditService } from '../../audit/index.js';
import { OrdersService } from '../../orders/index.js';
import { PiiService } from '../../pii/index.js';
import { TokenService } from './token.service.js';

export type CustomerPrincipal = Extract<Principal, { kind: 'customer' }>;

interface UserRow {
  id: string;
  customer_token: string;
  password_hash: string;
  role: Role;
  mfa_secret_enc: string | null;
  mfa_enabled: boolean;
  locked_until: Date | null;
  created_at: Date;
}

const MAX_FAILURES = 5;
const LOCK_S = 15 * 60;
const REFRESH_TTL_S = 30 * 86_400;

/** One message for every login failure, so it never tells an attacker which part was wrong. */
const invalidLogin = () =>
  new AppError('unauthorized', 'Email or password is incorrect, or the account is temporarily locked');
const sessionEnded = () => new AppError('unauthorized', 'Your session has ended. Sign in again.');

let dummy: Promise<string> | undefined;
/** Unknown emails still pay for one scrypt, so response time does not reveal which accounts exist. */
const dummyHash = (): Promise<string> => (dummy ??= hashPassword(randomToken(16)));

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

/** Customer and admin accounts. Credentials hold only a blind index of the email; the email itself lives in the PII vault. */
@Injectable()
export class AccountService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(KEYS) private readonly keys: KeyRing,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PiiService) private readonly pii: PiiService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  async register(input: RegisterInput): Promise<TokenResponse> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await inTransaction(this.db, async (tx) => {
        const exists = await one(
          tx,
          sql`SELECT 1 FROM users WHERE email_bidx = ${this.emailIndex(input.email)}`,
        );
        if (exists)
          throw new AppError('conflict', 'An account already exists for this email. Sign in instead.');
        const u = await this.createUser(tx, {
          email: input.email,
          name: input.name,
          passwordHash,
          role: 'customer',
        });
        await this.pii.recordConsent(tx, u.customer_token, 'marketing', input.consents.marketing, 'register');
        return this.session(tx, u, false);
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new AppError('conflict', 'An account already exists for this email. Sign in instead.');
      throw e;
    }
  }

  async login(input: LoginInput): Promise<TokenResponse> {
    const u = await one<UserRow>(
      this.db,
      sql`SELECT * FROM users WHERE email_bidx = ${this.emailIndex(input.email)} AND status = 'active'`,
    );
    const passwordOk = await verifyPassword(input.password, u?.password_hash ?? (await dummyHash()));
    const now = this.clock.now();
    if (!u || (u.locked_until && u.locked_until > now)) throw invalidLogin();
    const secret = this.mfaSecret(u);
    const totpOk =
      !u.mfa_enabled || (input.totp !== undefined && secret !== null && verifyTotp(secret, input.totp, now));
    if (!passwordOk || !totpOk) {
      await this.db.execute(
        sql`UPDATE users SET
              failed_logins = CASE WHEN failed_logins + 1 >= ${MAX_FAILURES} THEN 0 ELSE failed_logins + 1 END,
              locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILURES} THEN ${addSeconds(now, LOCK_S)}::timestamptz ELSE locked_until END,
              updated_at = now()
            WHERE id = ${u.id}`,
      );
      throw invalidLogin();
    }
    await this.db.execute(
      sql`UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = ${u.id}`,
    );
    return this.session(this.db, u, u.mfa_enabled);
  }

  /** Rotates the refresh token. Presenting a token that was already rotated ends every session of that user. */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const now = this.clock.now();
    const result = await inTransaction(this.db, async (tx) => {
      const t = await one<{ id: string; user_id: string; revoked_at: Date | null; expires_at: Date }>(
        tx,
        sql`SELECT id, user_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = ${sha256Hex(refreshToken)} FOR UPDATE`,
      );
      if (!t || t.expires_at <= now) return null;
      if (t.revoked_at) {
        await tx.execute(
          sql`UPDATE refresh_tokens SET revoked_at = ${now} WHERE user_id = ${t.user_id} AND revoked_at IS NULL`,
        );
        await this.audit.record(tx, 'system', 'identity.refresh_token_reused', t.user_id);
        return null;
      }
      const u = await one<UserRow>(
        tx,
        sql`SELECT * FROM users WHERE id = ${t.user_id} AND status = 'active'`,
      );
      if (!u) return null;
      await tx.execute(sql`UPDATE refresh_tokens SET revoked_at = ${now} WHERE id = ${t.id}`);
      return this.session(tx, u, u.mfa_enabled);
    });
    if (!result) throw sessionEnded();
    return result;
  }

  async me(who: CustomerPrincipal): Promise<MeView> {
    const person = await this.pii.customer(who.customerToken);
    const u = await one<{ mfa_enabled: boolean }>(
      this.db,
      sql`SELECT mfa_enabled FROM users WHERE customer_token = ${who.customerToken}`,
    );
    return {
      customerToken: who.customerToken,
      role: who.role,
      name: person?.name ?? null,
      email: person?.email ?? null,
      mfaEnabled: u?.mfa_enabled ?? false,
      consents: await this.pii.consents(who.customerToken),
    };
  }

  async updateConsent(who: CustomerPrincipal, purpose: ConsentPurpose, granted: boolean): Promise<MeView> {
    await this.pii.recordConsent(this.db, who.customerToken, purpose, granted, 'account');
    return this.me(who);
  }

  /** DPDP export: what the vault holds about the person, plus their orders. */
  async exportData(who: CustomerPrincipal): Promise<Record<string, unknown>> {
    const u = await one<{ role: Role; mfa_enabled: boolean; created_at: Date }>(
      this.db,
      sql`SELECT role, mfa_enabled, created_at FROM users WHERE customer_token = ${who.customerToken} AND status = 'active'`,
    );
    return {
      account: u ? { role: u.role, mfaEnabled: u.mfa_enabled, createdAt: u.created_at.toISOString() } : null,
      ...(await this.pii.export(who.customerToken)),
      orders: await this.orders.listForCustomer(who, 100, 0),
    };
  }

  /** DPDP erasure: crypto-shred the vault, anonymise the account, end every session. Orders keep only tokens. */
  async erase(who: CustomerPrincipal): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      await this.pii.erase(tx, who.customerToken);
      await tx.execute(
        sql`UPDATE users SET status = 'erased', email_bidx = 'erased:' || id::text, password_hash = '!', mfa_secret_enc = NULL,
              mfa_enabled = false, updated_at = now() WHERE customer_token = ${who.customerToken}`,
      );
      await tx.execute(
        sql`UPDATE refresh_tokens SET revoked_at = ${this.clock.now()}
            WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE customer_token = ${who.customerToken})`,
      );
      await this.audit.record(tx, who.subject, 'identity.erased', who.customerToken);
    });
  }

  async mfaSetup(who: CustomerPrincipal): Promise<{ secret: string; otpauthUrl: string }> {
    const u = await this.userOf(who);
    // Re-enrolling would let a stolen session replace the owner's authenticator.
    if (u.mfa_enabled) throw new AppError('conflict', 'Two-factor sign-in is already enabled');
    const secret = newTotpSecret();
    await this.db.execute(
      sql`UPDATE users SET mfa_secret_enc = ${this.sealMfa(u.id, secret)}, updated_at = now() WHERE id = ${u.id}`,
    );
    return {
      secret,
      otpauthUrl: `otpauth://totp/AgentBazaar:account?secret=${secret}&issuer=AgentBazaar&algorithm=SHA1&digits=6&period=30`,
    };
  }

  async mfaVerify(who: CustomerPrincipal, code: string): Promise<void> {
    const u = await this.userOf(who);
    const secret = this.mfaSecret(u);
    if (secret === null) throw new AppError('conflict', 'Start two-factor setup first');
    if (!verifyTotp(secret, code, this.clock.now())) {
      throw new AppError(
        'validation_failed',
        'That code is not valid. Check the time on your device and try again.',
      );
    }
    await this.db.execute(sql`UPDATE users SET mfa_enabled = true, updated_at = now() WHERE id = ${u.id}`);
    await this.audit.record(null, who.subject, 'identity.mfa_enabled', u.id);
  }

  /** For the CLI and seeding: an admin with MFA already enabled. Returns the TOTP secret to hand over once. */
  async createAdmin(p: {
    email: string;
    password: string;
    name?: string;
  }): Promise<{ userId: string; totpSecret: string }> {
    const passwordHash = await hashPassword(p.password);
    const totpSecret = newTotpSecret();
    const user = await inTransaction(this.db, async (tx) => {
      if (await one(tx, sql`SELECT 1 FROM users WHERE email_bidx = ${this.emailIndex(p.email)}`)) {
        throw new AppError('conflict', 'An account already exists for this email');
      }
      return this.createUser(tx, {
        email: p.email,
        name: p.name ?? 'Store admin',
        passwordHash,
        role: 'admin',
        totpSecret,
      });
    });
    await this.audit.record(null, 'cli', 'identity.admin_created', user.id);
    return { userId: user.id, totpSecret };
  }

  private async createUser(
    tx: Executor,
    p: { email: string; name: string; passwordHash: string; role: Role; totpSecret?: string },
  ): Promise<UserRow> {
    const id = randomUUID();
    const customerToken = await this.pii.upsertCustomer(tx, { email: p.email, name: p.name });
    const u = await one<UserRow>(
      tx,
      sql`INSERT INTO users (id, customer_token, email_bidx, password_hash, role, mfa_secret_enc, mfa_enabled)
          VALUES (${id}, ${customerToken}, ${this.emailIndex(p.email)}, ${p.passwordHash}, ${p.role},
                  ${p.totpSecret ? this.sealMfa(id, p.totpSecret) : null}, ${p.totpSecret !== undefined})
          RETURNING *`,
    );
    await this.pii.recordConsent(tx, customerToken, 'terms', true, 'register');
    return u!;
  }

  private async session(ex: Executor, u: UserRow, mfa: boolean): Promise<TokenResponse> {
    const access = await this.tokens.issueCustomer({
      userId: u.id,
      customerToken: u.customer_token,
      role: u.role,
      mfa,
    });
    const refreshToken = `rt_${randomToken(32)}`;
    await ex.execute(
      sql`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
          VALUES (${u.id}, ${sha256Hex(refreshToken)}, ${addSeconds(this.clock.now(), REFRESH_TTL_S)})`,
    );
    return {
      accessToken: access.accessToken,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      refreshToken,
      role: u.role,
    };
  }

  private async userOf(who: CustomerPrincipal): Promise<UserRow> {
    const u = await one<UserRow>(
      this.db,
      sql`SELECT * FROM users WHERE customer_token = ${who.customerToken} AND status = 'active'`,
    );
    if (!u) throw notFound('Account');
    return u;
  }

  private emailIndex(email: string): string {
    return blindIndex(this.keys.blindIndexKey, 'email', email);
  }

  private sealMfa(userId: string, secret: string): string {
    return aeadEncrypt(this.keys.piiMasterKey, secret, `mfa:${userId}`);
  }

  private mfaSecret(u: UserRow): string | null {
    return u.mfa_secret_enc
      ? aeadDecrypt(this.keys.piiMasterKey, u.mfa_secret_enc, `mfa:${u.id}`).toString('utf8')
      : null;
  }
}
