import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blindIndex, generateKeyEnv, loadKeyRing, LocalKeyWrapper, signToken, verifyToken } from './keyring.js';
import { b64url, hmacSha256, sha256Hex } from './primitives.js';

const KEY = Buffer.alloc(32, 7);
const NOW = new Date('2026-11-05T10:00:00.000Z');
const nowSec = NOW.getTime() / 1000;

/** Re-signs a hand-made body the way signToken does, to reach the checks that run after the MAC. */
const forge = (body: string, purpose = 'quote') => `${b64url(Buffer.from(body))}.${b64url(hmacSha256(KEY, `${purpose}.${b64url(Buffer.from(body))}`))}`;

describe('@lite signed tokens (quotes, checkout links)', () => {
  it('round-trips the payload and keeps it readable but tamper-evident', () => {
    const token = signToken(KEY, 'quote', { qid: 'q1', sub: 'anon:abc', exp: nowSec + 60 });
    const [body, mac] = token.split('.');
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))).toEqual({ qid: 'q1', sub: 'anon:abc', exp: nowSec + 60 });
    expect(mac).toBe(b64url(hmacSha256(KEY, `quote.${body}`)));
    expect(verifyToken(KEY, 'quote', token, NOW)).toEqual({ ok: true, payload: { qid: 'q1', sub: 'anon:abc', exp: nowSec + 60 } });
  });

  it('binds the purpose and the key into the signature', () => {
    const token = signToken(KEY, 'quote', { exp: nowSec + 60 });
    expect(verifyToken(KEY, 'checkout', token, NOW)).toEqual({ ok: false, reason: 'signature' });
    expect(verifyToken(Buffer.alloc(32, 8), 'quote', token, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects an edited body or signature', () => {
    const token = signToken(KEY, 'quote', { qid: 'q1', exp: nowSec + 60 });
    const [body, mac] = token.split('.') as [string, string];
    const richer = b64url(Buffer.from(JSON.stringify({ qid: 'q2', exp: nowSec + 60 })));
    expect(verifyToken(KEY, 'quote', `${richer}.${mac}`, NOW)).toEqual({ ok: false, reason: 'signature' });
    const flipped = `${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifyToken(KEY, 'quote', flipped, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('calls a token malformed unless it is exactly two non-empty parts', () => {
    const token = signToken(KEY, 'quote', { exp: nowSec + 60 });
    const [body, mac] = token.split('.') as [string, string];
    for (const bad of ['', 'abc', `${body}.`, `.${mac}`, `${token}.extra`, `${body}.${mac}.${mac}`]) {
      expect(verifyToken(KEY, 'quote', bad, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('calls a correctly signed body that is not JSON malformed', () => {
    expect(verifyToken(KEY, 'quote', forge('not json'), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('always enforces expiry, including a missing or non-numeric exp and the exact expiry second', () => {
    expect(verifyToken(KEY, 'quote', forge(JSON.stringify({ qid: 'q1' })), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyToken(KEY, 'quote', forge(JSON.stringify({ exp: String(nowSec + 60) })), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyToken(KEY, 'quote', signToken(KEY, 'quote', { exp: nowSec }), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyToken(KEY, 'quote', signToken(KEY, 'quote', { exp: nowSec - 1 }), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyToken(KEY, 'quote', signToken(KEY, 'quote', { exp: nowSec + 1 }), NOW).ok).toBe(true);
  });
});

describe('@lite key ring', () => {
  const env = {
    QUOTE_SIGNING_KEY: randomBytes(32).toString('base64'),
    PII_MASTER_KEY: randomBytes(32).toString('base64'),
    PII_BLIND_INDEX_KEY: randomBytes(40).toString('base64'),
  };

  it('generates ephemeral keys for anything unset and says which ones', () => {
    const ring = loadKeyRing({});
    expect(ring.ephemeral).toEqual(['QUOTE_SIGNING_KEY', 'PII_MASTER_KEY', 'PII_BLIND_INDEX_KEY', 'JWT_PRIVATE_KEY']);
    for (const k of [ring.quoteKey, ring.piiMasterKey, ring.blindIndexKey]) expect(k).toHaveLength(32);
    expect(new Set([ring.quoteKey, ring.piiMasterKey, ring.blindIndexKey].map((k) => k.toString('hex'))).size).toBe(3);
    expect(ring.jwtPrivateKey.asymmetricKeyType).toBe('ed25519');
  });

  it('uses configured keys, keeping the first 32 bytes, and derives a short key id from the PII master key', () => {
    const ring = loadKeyRing(env);
    expect(ring.ephemeral).toEqual(['JWT_PRIVATE_KEY']);
    expect(ring.quoteKey.equals(Buffer.from(env.QUOTE_SIGNING_KEY, 'base64'))).toBe(true);
    expect(ring.piiMasterKey.equals(Buffer.from(env.PII_MASTER_KEY, 'base64'))).toBe(true);
    expect(ring.blindIndexKey.equals(Buffer.from(env.PII_BLIND_INDEX_KEY, 'base64').subarray(0, 32))).toBe(true);
    expect(ring.piiKeyId).toBe(sha256Hex(ring.piiMasterKey).slice(0, 12));
    expect(ring.piiKeyId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('refuses keys shorter than 32 bytes and names the variable', () => {
    expect(() => loadKeyRing({ ...env, PII_MASTER_KEY: randomBytes(31).toString('base64') })).toThrow(
      'PII_MASTER_KEY must be at least 32 bytes, base64-encoded',
    );
    expect(() => loadKeyRing({ QUOTE_SIGNING_KEY: randomBytes(16).toString('base64') })).toThrow(/^QUOTE_SIGNING_KEY must/);
  });

  it('loads a PEM private key from a one-line env value and exposes the matching public key', () => {
    const generated = generateKeyEnv();
    expect(generated.JWT_PRIVATE_KEY).not.toContain('\n');
    expect(generated.JWT_PRIVATE_KEY).toContain('\\n');
    const ring = loadKeyRing(generated);
    expect(ring.ephemeral).toEqual([]);
    const signature = sign(null, Buffer.from('hello'), ring.jwtPrivateKey);
    expect(verify(null, Buffer.from('hello'), ring.jwtPublicKey, signature)).toBe(true);
    expect(ring.jwtPublicKey.export({ format: 'der', type: 'spki' })).toEqual(
      createPublicKey(ring.jwtPrivateKey).export({ format: 'der', type: 'spki' }),
    );
  });

  it('generates fresh, distinct 32-byte keys every time', () => {
    const a = generateKeyEnv();
    const b = generateKeyEnv();
    expect(Object.keys(a).sort()).toEqual(['JWT_PRIVATE_KEY', 'PII_BLIND_INDEX_KEY', 'PII_MASTER_KEY', 'QUOTE_SIGNING_KEY']);
    for (const k of ['QUOTE_SIGNING_KEY', 'PII_MASTER_KEY', 'PII_BLIND_INDEX_KEY'] as const) {
      expect(Buffer.from(a[k]!, 'base64')).toHaveLength(32);
      expect(a[k]).not.toBe(b[k]);
    }
    expect(a.JWT_PRIVATE_KEY).toMatch(/^-----BEGIN PRIVATE KEY-----\\n/);
  });
});

describe('@lite envelope encryption and blind indexes', () => {
  const kek = randomBytes(32);

  it('wraps a data key so only the same key id and context unwrap it', async () => {
    const wrapper = new LocalKeyWrapper(kek, 'k1');
    const dek = randomBytes(32);
    const wrapped = await wrapper.wrap(dek, 'customer:42');
    expect(wrapper.keyId).toBe('k1');
    expect(wrapped).toMatch(/^v1\./);
    expect((await wrapper.unwrap(wrapped, 'customer:42')).equals(dek)).toBe(true);
    await expect(wrapper.unwrap(wrapped, 'customer:43')).rejects.toThrow();
    await expect(new LocalKeyWrapper(kek, 'k2').unwrap(wrapped, 'customer:42')).rejects.toThrow();
  });

  it('indexes equal values equally after trimming and lower-casing, separately per kind and key', () => {
    const key = randomBytes(32);
    const idx = blindIndex(key, 'email', 'Asha@Example.com');
    expect(blindIndex(key, 'email', '  asha@example.COM ')).toBe(idx);
    expect(idx).toBe(b64url(hmacSha256(key, 'email:asha@example.com')));
    expect(blindIndex(key, 'phone', 'Asha@Example.com')).not.toBe(idx);
    expect(blindIndex(randomBytes(32), 'email', 'Asha@Example.com')).not.toBe(idx);
  });
});

describe('@lite ed25519 sanity for the generated JWT key', () => {
  it('rejects a signature from another key pair', () => {
    const ring = loadKeyRing(generateKeyEnv());
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(verify(null, Buffer.from('x'), ring.jwtPublicKey, sign(null, Buffer.from('x'), other))).toBe(false);
  });
});
