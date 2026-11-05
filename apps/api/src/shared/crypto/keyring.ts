import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { Env } from '@agentbazaar/config';
import { aeadDecrypt, aeadEncrypt, b64url, fromB64url, hmacSha256, safeEqual, sha256Hex } from './primitives.js';

export interface KeyRing {
  readonly quoteKey: Buffer;
  readonly piiMasterKey: Buffer;
  readonly piiKeyId: string;
  readonly blindIndexKey: Buffer;
  readonly jwtPrivateKey: KeyObject;
  readonly jwtPublicKey: KeyObject;
  readonly ephemeral: readonly string[];
}

function decodeKey(name: string, value: string | undefined, ephemeral: string[]): Buffer {
  if (!value) {
    ephemeral.push(name);
    return randomBytes(32);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.length < 32) throw new Error(`${name} must be at least 32 bytes, base64-encoded`);
  return buf.subarray(0, 32);
}

export function loadKeyRing(env: Pick<Env, 'QUOTE_SIGNING_KEY' | 'PII_MASTER_KEY' | 'PII_BLIND_INDEX_KEY' | 'JWT_PRIVATE_KEY'>): KeyRing {
  const ephemeral: string[] = [];
  const quoteKey = decodeKey('QUOTE_SIGNING_KEY', env.QUOTE_SIGNING_KEY, ephemeral);
  const piiMasterKey = decodeKey('PII_MASTER_KEY', env.PII_MASTER_KEY, ephemeral);
  const blindIndexKey = decodeKey('PII_BLIND_INDEX_KEY', env.PII_BLIND_INDEX_KEY, ephemeral);
  let jwtPrivateKey: KeyObject;
  if (env.JWT_PRIVATE_KEY) {
    jwtPrivateKey = createPrivateKey(env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'));
  } else {
    ephemeral.push('JWT_PRIVATE_KEY');
    jwtPrivateKey = generateKeyPairSync('ed25519').privateKey;
  }
  return {
    quoteKey,
    piiMasterKey,
    piiKeyId: sha256Hex(piiMasterKey).slice(0, 12),
    blindIndexKey,
    jwtPrivateKey,
    jwtPublicKey: createPublicKey(jwtPrivateKey),
    ephemeral,
  };
}

/** Fresh key material for `.env` files (`pnpm --filter @agentbazaar/api cli keys`). */
export function generateKeyEnv(): Record<string, string> {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    QUOTE_SIGNING_KEY: randomBytes(32).toString('base64'),
    PII_MASTER_KEY: randomBytes(32).toString('base64'),
    PII_BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'),
  };
}

/**
 * Compact signed tokens: base64url(json).base64url(hmac). The purpose is mixed into the MAC so a
 * checkout token can never be replayed as a quote token, and `exp` is always enforced.
 */
export function signToken(key: Buffer, purpose: string, payload: Record<string, unknown> & { exp: number }): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64url(hmacSha256(key, `${purpose}.${body}`))}`;
}

export type VerifyResult<T> = { ok: true; payload: T } | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export function verifyToken<T extends { exp: number }>(key: Buffer, purpose: string, token: string, now: Date): VerifyResult<T> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const expected = hmacSha256(key, `${purpose}.${parts[0]}`);
  if (!safeEqual(expected, fromB64url(parts[1]))) return { ok: false, reason: 'signature' };
  let payload: T;
  try {
    payload = JSON.parse(fromB64url(parts[0]).toString('utf8')) as T;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

/** Envelope encryption: a per-record data key, wrapped by the master key (or a KMS/OpenBao in growth). */
export interface KeyWrapper {
  readonly keyId: string;
  wrap(dek: Buffer, context: string): Promise<string>;
  unwrap(wrapped: string, context: string): Promise<Buffer>;
}

export class LocalKeyWrapper implements KeyWrapper {
  constructor(
    private readonly kek: Buffer,
    readonly keyId: string,
  ) {}
  async wrap(dek: Buffer, context: string): Promise<string> {
    return aeadEncrypt(this.kek, dek, `dek:${this.keyId}:${context}`);
  }
  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    return aeadDecrypt(this.kek, wrapped, `dek:${this.keyId}:${context}`);
  }
}

/** Deterministic keyed hash for equality lookups on encrypted fields (email, phone). */
export function blindIndex(key: Buffer, kind: string, value: string): string {
  return b64url(hmacSha256(key, `${kind}:${value.trim().toLowerCase()}`));
}
