import { Bulkhead, CircuitBreaker, withTimeout } from '../../../shared/resilience/resilience.js';

export interface ResilienceOptions {
  timeoutMs: number;
  failureThreshold?: number;
  resetMs?: number;
  maxConcurrent?: number;
  maxQueue?: number;
  now?: () => number;
}

/** Guards one remote dependency: a concurrency cap, then a circuit breaker, then an aborting timeout. */
export class RemoteGuard {
  private readonly breaker: CircuitBreaker;
  private readonly bulkhead: Bulkhead;

  constructor(
    name: string,
    private readonly opts: ResilienceOptions,
  ) {
    this.breaker = new CircuitBreaker(name, opts.failureThreshold ?? 5, opts.resetMs ?? 30_000, opts.now);
    this.bulkhead = new Bulkhead(name, opts.maxConcurrent ?? 16, opts.maxQueue ?? 64);
  }

  get state() {
    return this.breaker.current;
  }

  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.bulkhead.exec(() => this.breaker.exec(() => withTimeout(work, this.opts.timeoutMs)));
  }
}
