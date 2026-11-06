import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

export const b64url = (b: Buffer): string => b.toString('base64url');
export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomToken = (bytes = 32): string => b64url(randomBytes(bytes));

/* ---------- AES-256-GCM with associated data ---------- */

const AEAD_VERSION = 'v1';

/** Encrypts with a fresh 96-bit IV. AAD binds the ciphertext to its context (e.g. customer + field). */
export function aeadEncrypt(key: Buffer, plaintext: string | Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${AEAD_VERSION}.${b64url(Buffer.concat([iv, ct, cipher.getAuthTag()]))}`;
}

export function aeadDecrypt(key: Buffer, token: string, aad: string): Buffer {
  const [version, body] = token.split('.');
  if (version !== AEAD_VERSION || !body) throw new Error('Unsupported ciphertext');
  const raw = fromB64url(body);
  if (raw.length < 12 + 16) throw new Error('Ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
}

/* ---------- Passwords (scrypt) ---------- */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 } as const;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, keylen, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = fromB64url(hash);
  const actual = await scrypt(password, fromB64url(salt), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return safeEqual(actual, expected);
}

/* ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ---------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretB32: string, at: Date, stepSeconds = 30): string {
  const counter = Math.floor(at.getTime() / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Accepts the current step and one step either side to absorb clock drift. */
export function verifyTotp(secretB32: string, code: string, at: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((w) => safeEqual(totp(secretB32, new Date(at.getTime() + w * 30_000)), code));
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));
