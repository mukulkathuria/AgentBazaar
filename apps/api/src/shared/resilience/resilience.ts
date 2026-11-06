import { AppError } from '../kernel/errors.js';

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  shouldRetry?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || (opts.shouldRetry && !opts.shouldRetry(err))) throw err;
      // Backoff jitter only spreads retries out; it guards nothing, so it needs no CSPRNG.
      await sleep(Math.random() * Math.min(opts.maxMs, opts.baseMs * 2 ** attempt)); // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator
    }
  }
}

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Opens after `failureThreshold` consecutive failures, rejects fast while open, then lets one
 * trial call through after `resetMs`. A success closes it again.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    readonly name: string,
    private readonly failureThreshold = 5,
    private readonly resetMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetMs) return 'half_open';
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.current;
    if (state === 'open' || (state === 'half_open' && this.trialInFlight)) {
      throw new AppError('unavailable', `${this.name} is temporarily unavailable`);
    }
    if (state === 'half_open') this.trialInFlight = true;
    try {
      const result = await fn();
      this.state = 'closed';
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (state === 'half_open' || this.failures >= this.failureThreshold) {
        this.state = 'open';
        this.openedAt = this.now();
      }
      throw err;
    } finally {
      if (state === 'half_open') this.trialInFlight = false;
    }
  }
}

/** Caps concurrent calls to a dependency so one slow service cannot exhaust the process. */
export class Bulkhead {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    readonly name: string,
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueue) throw new AppError('unavailable', `${this.name} is busy, try again`);
      // The releasing caller hands its slot over, so `active` already counts us when we wake.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
