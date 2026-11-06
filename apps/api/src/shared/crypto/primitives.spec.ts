import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aeadDecrypt,
  aeadEncrypt,
  b64url,
  base32Decode,
  base32Encode,
  fromB64url,
  hashPassword,
  newTotpSecret,
  randomToken,
  safeEqual,
  totp,
  verifyPassword,
  verifyTotp,
} from './primitives.js';

describe('@lite crypto primitives', () => {
  it('compares secrets in constant time and treats different lengths as different', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual(Buffer.from('abc'), 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('makes url-safe random tokens of the requested strength', () => {
    expect(fromB64url(randomToken())).toHaveLength(32);
    expect(fromB64url(randomToken(12))).toHaveLength(12);
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(b64url(Buffer.from([251, 255]))).toBe('-_8');
  });

  describe('AES-256-GCM with associated data', () => {
    const key = randomBytes(32);

    it('round-trips and binds the ciphertext to its context', () => {
      const token = aeadEncrypt(key, 'Asha Verma', 'customer:1:name');
      expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
      expect(aeadEncrypt(key, 'Asha Verma', 'customer:1:name')).not.toBe(token);
      expect(aeadDecrypt(key, token, 'customer:1:name').toString('utf8')).toBe('Asha Verma');
      expect(() => aeadDecrypt(key, token, 'customer:2:name')).toThrow();
      expect(() => aeadDecrypt(randomBytes(32), token, 'customer:1:name')).toThrow();
    });

    it('rejects unknown versions, missing bodies and truncated ciphertexts', () => {
      const token = aeadEncrypt(key, 'x', 'ctx');
      expect(() => aeadDecrypt(key, token.replace('v1.', 'v2.'), 'ctx')).toThrow('Unsupported ciphertext');
      expect(() => aeadDecrypt(key, 'v1', 'ctx')).toThrow('Unsupported ciphertext');
      expect(() => aeadDecrypt(key, 'v1.', 'ctx')).toThrow('Unsupported ciphertext');
      expect(() => aeadDecrypt(key, `v1.${b64url(randomBytes(27))}`, 'ctx')).toThrow('Ciphertext too short');
      // 28 bytes is the minimum frame: IV and tag around an empty plaintext.
      expect(aeadDecrypt(key, aeadEncrypt(key, '', 'ctx'), 'ctx')).toHaveLength(0);
    });
  });

  describe('passwords (scrypt)', () => {
    it('verifies the right password only, with a fresh salt each time', async () => {
      const stored = await hashPassword('Correct-horse-9');
      expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
      expect(await hashPassword('Correct-horse-9')).not.toBe(stored);
      expect(await verifyPassword('Correct-horse-9', stored)).toBe(true);
      expect(await verifyPassword('correct-horse-9', stored)).toBe(false);
    });

    it('normalises Unicode so the same password typed two ways matches', async () => {
      const stored = await hashPassword('Café-pass-1');
      expect(await verifyPassword('Café-pass-1', stored)).toBe(true);
    });

    it('rejects stored values that are not scrypt hashes', async () => {
      const stored = await hashPassword('pw-123456');
      expect(await verifyPassword('pw-123456', stored.replace(/^scrypt/, 'bcrypt'))).toBe(false);
      expect(await verifyPassword('pw-123456', stored.split('$').slice(0, 5).join('$'))).toBe(false);
      expect(await verifyPassword('pw-123456', `${stored}$extra`)).toBe(false);
    });
  });

  describe('TOTP (RFC 6238)', () => {
    // RFC 6238 appendix B, SHA-1 secret "12345678901234567890".
    const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

    it('matches the RFC test vectors', () => {
      expect(rfcSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
      expect(totp(rfcSecret, new Date(59_000))).toBe('287082');
      expect(totp(rfcSecret, new Date(1_111_111_109_000))).toBe('081804');
      expect(totp(rfcSecret, new Date(1_234_567_890_000))).toBe('005924');
      expect(totp(rfcSecret, new Date(2_000_000_000_000))).toBe('279037');
    });

    it('round-trips base32, ignoring case, spaces and padding, and rejects foreign characters', () => {
      for (const n of [0, 1, 2, 3, 4, 5, 7, 20]) {
        const buf = randomBytes(n);
        expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
      }
      expect(base32Encode(Buffer.from('f'))).toBe('MY');
      expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
      expect(base32Decode('mzxq====').toString()).toBe('fo');
      expect(base32Decode('MZ XQ').toString()).toBe('fo');
      expect(() => base32Decode('MZX1')).toThrow('Invalid base32');
    });

    it('accepts one step of clock drift either way and nothing further', () => {
      const secret = newTotpSecret();
      expect(base32Decode(secret)).toHaveLength(20);
      const at = new Date('2026-11-05T10:00:15.000Z');
      expect(verifyTotp(secret, totp(secret, at), at)).toBe(true);
      expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 30_000)), at)).toBe(true);
      expect(verifyTotp(secret, totp(secret, new Date(at.getTime() + 30_000)), at)).toBe(true);
      expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 60_000)), at)).toBe(false);
      expect(verifyTotp(secret, totp(secret, new Date(at.getTime() + 60_000)), at)).toBe(false);
    });

    it('rejects anything but six digits', () => {
      const secret = newTotpSecret();
      const at = new Date();
      const code = totp(secret, at);
      for (const bad of ['', '12345', '1234567', 'abcdef', ` ${code}`, `${code}\n`]) expect(verifyTotp(secret, bad, at)).toBe(false);
      expect(totp(secret, at, 60)).toMatch(/^\d{6}$/);
    });
  });
});
