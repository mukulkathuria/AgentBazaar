import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { AddressInput } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenBaoKeyWrapper, PiiService, rewrapDataKeys } from '../../src/modules/pii/index.js';
import { LocalKeyWrapper, loadKeyRing, type KeyWrapper } from '../../src/shared/crypto/keyring.js';
import { inTransaction, rows, type Executor } from '../../src/shared/db/database.js';
import { systemClock } from '../../src/shared/kernel/clock.js';
import { createTestDb, type TestDb } from '../support/test-db.js';

const ADDR = process.env.OPENBAO_ADDR!;
const TOKEN = process.env.OPENBAO_TOKEN!;
// A Transit mount of our own on the shared dev server, removed afterwards.
const MOUNT = `t6-transit-${randomUUID().slice(0, 8)}`;

async function bao(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
}

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

beforeAll(async () => {
  await bao('POST', `sys/mounts/${MOUNT}`, { type: 'transit' });
  for (const key of ['t6-pii', 't6-pii-rewrap']) await bao('POST', `${MOUNT}/keys/${key}`, { derived: true });
});

afterAll(() => bao('DELETE', `sys/mounts/${MOUNT}`));

describe('OpenBao Transit key wrapper @growth', () => {
  const KEY = 't6-pii';
  const transit = () => new OpenBaoKeyWrapper(ADDR, TOKEN, KEY, MOUNT);

  it('wraps and unwraps a data key bound to the customer token', async () => {
    const w = transit();
    const dek = randomBytes(32);
    const wrapped = await w.wrap(dek, 'cus_a');
    expect(wrapped).toMatch(/^vault:v1:/);
    expect((await w.unwrap(wrapped, 'cus_a')).equals(dek)).toBe(true);
    // The derived key differs per customer, so one customer's wrapped key opens nothing else.
    await expect(w.unwrap(wrapped, 'cus_b')).rejects.toThrow(
      /^OpenBao decrypt with transit key "t6-pii" failed with HTTP 400/,
    );
  });

  it('keeps old versions readable after a rotation and re-wraps them to the latest', async () => {
    const w = transit();
    const dek = randomBytes(32);
    const v1 = await w.wrap(dek, 'cus_r');
    await bao('POST', `${MOUNT}/keys/${KEY}/rotate`);
    expect(await w.latestVersion()).toBe(2);
    expect((await w.unwrap(v1, 'cus_r')).equals(dek)).toBe(true);
    expect(await w.wrap(dek, 'cus_r')).toMatch(/^vault:v2:/);
    const v2 = await w.rewrap(v1, 'cus_r');
    expect(v2).toMatch(/^vault:v2:/);
    // Once old versions are retired, only re-wrapped data keys still open.
    await bao('POST', `${MOUNT}/keys/${KEY}/config`, { min_decryption_version: 2 });
    await expect(w.unwrap(v1, 'cus_r')).rejects.toThrow(/failed with HTTP 400/);
    expect((await w.unwrap(v2, 'cus_r')).equals(dek)).toBe(true);
  });

  it('fails with a clear error when OpenBao is down, hangs or refuses the token', async () => {
    const port = await freePort();
    const down = new OpenBaoKeyWrapper(`http://127.0.0.1:${port}`, TOKEN, KEY, MOUNT);
    await expect(down.wrap(randomBytes(32), 'cus_x')).rejects.toThrow(
      `OpenBao at http://127.0.0.1:${port}/v1/${MOUNT} is unreachable: ECONNREFUSED`,
    );
    // After five straight failures the breaker answers at once, as a 503 for API callers.
    for (let i = 0; i < 4; i++) await down.wrap(randomBytes(32), 'cus_x').catch(() => undefined);
    await expect(down.wrap(randomBytes(32), 'cus_x')).rejects.toMatchObject({
      code: 'unavailable',
      message: 'openbao is temporarily unavailable',
    });

    const silent = createServer(() => undefined).listen(0, '127.0.0.1'); // accepts, never answers
    await once(silent, 'listening');
    const hung = new OpenBaoKeyWrapper(
      `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
      TOKEN,
      KEY,
      MOUNT,
    );
    await expect(hung.unwrap('vault:v1:AAAA', 'cus_x')).rejects.toThrow(
      /\/v1\/t6-transit-\w+ did not answer within 3000 ms$/,
    );
    silent.close();

    const wrongToken = new OpenBaoKeyWrapper(ADDR, 'not-a-real-token', KEY, MOUNT);
    await expect(wrongToken.wrap(randomBytes(32), 'cus_x')).rejects.toThrow(
      'OpenBao encrypt with transit key "t6-pii" failed with HTTP 403: permission denied',
    );
  });
});

const address = (i: number): AddressInput => ({
  name: `Customer ${i}`,
  phone: `98765${String(10000 + i)}`,
  line1: `${i} MG Road`,
  city: 'Bengaluru',
  stateCode: 'KA',
  pincode: '560001',
});

describe('pii rewrap: env master key to OpenBao Transit @growth', () => {
  const KEY = 't6-pii-rewrap';
  const transit = () => new OpenBaoKeyWrapper(ADDR, TOKEN, KEY, MOUNT);
  const masterKey = randomBytes(32).toString('base64');
  const keys = loadKeyRing({ PII_MASTER_KEY: masterKey });
  const local = new LocalKeyWrapper(keys.piiMasterKey, keys.piiKeyId);
  const all: string[] = [];
  let testDb: TestDb;
  let db: Executor;

  beforeAll(async () => {
    testDb = await createTestDb({ poolMax: 4 });
    db = testDb.database.db;
  });
  afterAll(() => testDb.cleanup());

  /** Customers created the lite way: their data keys are wrapped by `wrapper` (the env master key). */
  async function seed(from: number, n: number, wrapper: KeyWrapper = local): Promise<string[]> {
    const lite = new PiiService(db, keys, wrapper, systemClock);
    const tokens: string[] = [];
    for (let i = from; i < from + n; i++) {
      const p = address(i);
      tokens.push(
        await inTransaction(db, async (tx) => {
          const t = await lite.upsertCustomer(tx, {
            email: `buyer${i}@example.com`,
            name: p.name,
            phone: p.phone,
          });
          await lite.storeAddress(tx, t, p);
          return t;
        }),
      );
    }
    if (wrapper === local) all.push(...tokens);
    return tokens;
  }

  const fieldCiphertext = () =>
    rows(
      db,
      sql`SELECT c.token, c.email_enc, c.phone_enc, c.name_enc, a.data_enc FROM pii.customers c
                 JOIN pii.addresses a ON a.customer_token = c.token ORDER BY c.token`,
    );

  /** How many data keys sit under each key and Transit version, e.g. { 'openbao:k v1': 7 }. */
  async function wrapping(): Promise<Record<string, number>> {
    const r = await rows<{ key_id: string; v: string; n: number }>(
      db,
      sql`SELECT key_id, CASE WHEN wrapped_dek LIKE 'vault:%' THEN split_part(wrapped_dek, ':', 2) ELSE 'env' END AS v,
                 count(*)::int AS n FROM pii.customers GROUP BY 1, 2`,
    );
    return Object.fromEntries(r.map((x) => [`${x.key_id} ${x.v}`, x.n]));
  }

  async function expectReadable(tokens: string[]): Promise<void> {
    const growth = new PiiService(db, keys, transit(), systemClock);
    for (const t of tokens) {
      const pii = await growth.customer(t);
      const i = Number(pii!.name!.split(' ')[1]);
      expect(pii).toEqual({ email: `buyer${i}@example.com`, name: `Customer ${i}`, phone: address(i).phone });
      expect(await growth.addresses(t)).toEqual([address(i)]);
    }
  }

  it('moves every data key without touching the encrypted PII, then has nothing left to do', async () => {
    await seed(0, 7);
    const before = await fieldCiphertext();

    expect(await rewrapDataKeys(db, local, transit(), 3)).toEqual({
      moved: 7,
      rotated: 0,
      remaining: 0,
      unknownKey: 0,
    });
    expect(await fieldCiphertext()).toEqual(before); // every field is byte-for-byte the same ciphertext
    expect(await wrapping()).toEqual({ [`openbao:${KEY} v1`]: 7 });
    await expectReadable(all);

    expect(await rewrapDataKeys(db, local, transit(), 3)).toEqual({
      moved: 0,
      rotated: 0,
      remaining: 0,
      unknownKey: 0,
    });
  });

  it('resumes after a crash mid-run, then re-wraps everything after a Transit key rotation', async () => {
    await seed(100, 5);
    let wraps = 0;
    const real = transit();
    const crashing = Object.assign(Object.create(real) as OpenBaoKeyWrapper, {
      wrap: (dek: Buffer, ctx: string) =>
        ++wraps === 4 ? Promise.reject(new Error('simulated crash')) : real.wrap(dek, ctx),
    });
    await expect(rewrapDataKeys(db, local, crashing, 2)).rejects.toThrow('simulated crash');
    // The first batch of two committed; the second rolled back as a whole.
    expect(await wrapping()).toEqual({ [`openbao:${KEY} v1`]: 9, [`${local.keyId} env`]: 3 });

    expect(await rewrapDataKeys(db, local, transit(), 2)).toEqual({
      moved: 3,
      rotated: 0,
      remaining: 0,
      unknownKey: 0,
    });
    expect(await wrapping()).toEqual({ [`openbao:${KEY} v1`]: 12 });

    await bao('POST', `${MOUNT}/keys/${KEY}/rotate`);
    expect(await rewrapDataKeys(db, local, transit(), 5)).toEqual({
      moved: 0,
      rotated: 12,
      remaining: 0,
      unknownKey: 0,
    });
    expect(await wrapping()).toEqual({ [`openbao:${KEY} v2`]: 12 });
    await bao('POST', `${MOUNT}/keys/${KEY}/config`, { min_decryption_version: 2 });
    await expectReadable(all); // nothing still needs the retired version
  });

  it('runs as `cli pii rewrap` and reports data keys under a key it does not hold', async () => {
    await seed(200, 3);
    const stray = new LocalKeyWrapper(randomBytes(32), 'stray-key-id');
    await seed(300, 1, stray);
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', 'src/cli/index.ts', 'pii', 'rewrap', '--batch-size', '2'],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: {
            ...process.env,
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            DATABASE_URL: testDb.url!,
            PII_MASTER_KEY: masterKey,
            OPENBAO_TRANSIT_KEY: KEY,
            OPENBAO_TRANSIT_MOUNT: MOUNT,
          },
        },
        (err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
      ),
    );
    expect(result.stdout).toContain(`Moved 3 data keys from PII_MASTER_KEY to OpenBao Transit key "${KEY}".`);
    expect(result.stdout).toContain(`Re-wrapped 0 data keys to the Transit key's latest version.`);
    expect(result.stderr).toContain('1 data keys are wrapped by another key');
    expect(result.code).toBe(1);
    expect(await wrapping()).toEqual({ [`openbao:${KEY} v2`]: 15, 'stray-key-id env': 1 });
    await expectReadable(all);
  }, 120_000);
});
