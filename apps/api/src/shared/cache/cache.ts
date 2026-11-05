/** Cache and counter port. Lite uses memory; growth and scale use Valkey (shared across nodes). */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomically increments a counter that expires `ttlSeconds` after its first increment. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  close(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** Bounded LRU with TTL. Map iteration order gives us LRU eviction cheaply. */
export class MemoryCache implements Cache {
  private readonly map = new Map<string, Entry>();

  constructor(
    private readonly maxEntries = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  private live(key: string): Entry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  private put(key: string, value: unknown, ttlSeconds: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.live(key)?.value as T | undefined;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.put(key, value, ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const e = this.live(key);
    if (!e) {
      this.put(key, 1, ttlSeconds);
      return 1;
    }
    e.value = (e.value as number) + 1;
    return e.value as number;
  }

  async close(): Promise<void> {
    this.map.clear();
  }
}
