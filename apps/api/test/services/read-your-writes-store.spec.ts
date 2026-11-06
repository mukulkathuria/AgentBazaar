// The per-principal WAL positions behind read-your-writes (ADR 0009) on the shared Valkey of
// tests/infra/docker-compose.yml. Keys carry a t5: prefix and a run id, and are deleted afterwards.
import { randomUUID } from 'node:crypto';
import { Valkey } from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValkeyCache, type ValkeyCache } from '../../src/shared/cache/valkey-cache.js';

const url = process.env.VALKEY_URL ?? 'redis://localhost:6379';
const key = `t5:${randomUUID().slice(0, 8)}:ryw:alice`;

describe('@growth read-your-writes positions on real Valkey (Cache.setMax)', () => {
  let cache: ValkeyCache;
  let raw: Valkey;

  beforeAll(async () => {
    cache = await createValkeyCache(url);
    raw = new Valkey(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await raw.connect();
  });
  afterAll(async () => {
    await raw?.del(key);
    await raw?.quit();
    await cache?.close();
  });

  it('keeps the largest position when many API instances record at once, exactly, beyond 32 bits', async () => {
    // WAL positions grow past 2^32 within days; Lua numbers are doubles, exact up to 2^53.
    const positions = Array.from({ length: 200 }, (_, i) => 2 ** 50 + ((i * 7_919) % 1_000));
    await Promise.all(positions.map((lsn) => cache.setMax(key, lsn, 30)));
    expect(await cache.get<number>(key)).toBe(Math.max(...positions));
  });

  it('never lowers the position, but restarts its expiry', async () => {
    const before = await cache.get<number>(key);
    await cache.setMax(key, 5, 120);
    expect(await cache.get<number>(key)).toBe(before);
    expect(await raw.ttl(key)).toBeGreaterThan(30);
  });
});
