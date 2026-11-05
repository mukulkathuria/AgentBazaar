import { Valkey } from 'iovalkey';
import type { Cache } from './cache.js';

/** Valkey adapter (growth/scale, or lite with VALKEY_URL): shared across API instances. */
export class ValkeyCache implements Cache {
  constructor(private readonly client: Valkey) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.ceil(ttlSeconds)));
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    // MULTI keeps INCR and the first EXPIRE atomic, so a crash cannot leave a counter without a TTL.
    const res = await this.client.multi().incr(key).expire(key, Math.max(1, Math.ceil(ttlSeconds)), 'NX').exec();
    const [err, value] = res?.[0] ?? [new Error('empty MULTI result'), null];
    if (err) throw err;
    return Number(value);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

export async function createValkeyCache(url: string): Promise<ValkeyCache> {
  const client = new Valkey(url, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  await client.connect();
  await client.ping();
  return new ValkeyCache(client);
}
