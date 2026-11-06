import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../kernel/errors.js';
import { Bulkhead, CircuitBreaker, retry, TimeoutError, withTimeout } from './resilience.js';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('@lite withTimeout', () => {
  it('returns the result of work that finishes in time and leaves no timer behind', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const result = withTimeout(async (s) => {
      signal = s;
      return 'done';
    }, 1000);
    await expect(result).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    expect(signal.aborted).toBe(false);
  });

  it('rejects with a TimeoutError and aborts the work when time runs out', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const slow = withTimeout((s) => {
      signal = s;
      return new Promise<string>(() => undefined);
    }, 250);
    const outcome = slow.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(249);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ name: 'TimeoutError', message: 'Timed out after 250 ms' });
    expect(signal.aborted).toBe(true);
  });

  it('passes through the error of work that fails in time', async () => {
    await expect(withTimeout(async () => Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });
});

describe('@lite retry with full-jitter backoff', () => {
  it('retries until success and backs off exponentially up to the cap', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const sleeps: number[] = [];
    const attempts: number[] = [];
    const result = await retry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 4) throw new Error(`fail ${attempt}`);
        return 'ok';
      },
      { retries: 5, baseMs: 100, maxMs: 500, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(attempts).toEqual([0, 1, 2, 3, 4]);
    // Half of min(500, 100 * 2^n): 50, 100, 200, then capped at 250.
    expect(sleeps).toEqual([50, 100, 200, 250]);
  });

  it('gives up after the last retry with the last error', async () => {
    const fn = vi.fn(async (attempt: number) => Promise.reject(new Error(`fail ${attempt}`)));
    await expect(retry(fn, { retries: 2, baseMs: 1, maxMs: 1, sleep: async () => undefined })).rejects.toThrow('fail 2');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry errors the caller marks as permanent', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => Promise.reject(new AppError('validation_failed', 'bad')));
    await expect(retry(fn, { retries: 5, baseMs: 1, maxMs: 1, sleep, shouldRetry: (e) => !(e instanceof AppError) })).rejects.toThrow('bad');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps on a real timer by default', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    let calls = 0;
    const done = retry(async () => {
      if (calls++ === 0) throw new Error('once');
      return calls;
    }, { retries: 1, baseMs: 40, maxMs: 1000 });
    await vi.advanceTimersByTimeAsync(39);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe(2);
  });
});

describe('@lite circuit breaker', () => {
  const fail = async () => Promise.reject(new Error('down'));
  const succeed = async () => 'up';

  it('opens after the threshold of consecutive failures and then fails fast', async () => {
    let t = 0;
    const breaker = new CircuitBreaker('ai-service', 3, 1000, () => t);
    const fn = vi.fn(fail);
    for (let i = 0; i < 3; i++) await expect(breaker.exec(fn)).rejects.toThrow('down');
    expect(breaker.current).toBe('open');
    const err = await breaker.exec(fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'unavailable', message: 'ai-service is temporarily unavailable' });
    expect(fn).toHaveBeenCalledTimes(3);
    t = 999;
    expect(breaker.current).toBe('open');
  });

  it('a success resets the failure count', async () => {
    const breaker = new CircuitBreaker('svc', 2, 1000, () => 0);
    await expect(breaker.exec(fail)).rejects.toThrow();
    await expect(breaker.exec(succeed)).resolves.toBe('up');
    await expect(breaker.exec(fail)).rejects.toThrow();
    expect(breaker.current).toBe('closed');
  });

  it('lets exactly one trial through after the reset window; success closes it', async () => {
    let t = 0;
    const breaker = new CircuitBreaker('svc', 1, 1000, () => t);
    await expect(breaker.exec(fail)).rejects.toThrow();
    t = 1000;
    expect(breaker.current).toBe('half_open');
    const trial = deferred<string>();
    const first = breaker.exec(() => trial.promise);
    await expect(breaker.exec(succeed)).rejects.toMatchObject({ code: 'unavailable' });
    trial.resolve('recovered');
    await expect(first).resolves.toBe('recovered');
    expect(breaker.current).toBe('closed');
    await expect(breaker.exec(succeed)).resolves.toBe('up');
  });

  it('re-opens straight away when the trial fails, even below the threshold', async () => {
    let t = 0;
    const breaker = new CircuitBreaker('svc', 1, 1000, () => t);
    await expect(breaker.exec(fail)).rejects.toThrow();
    t = 1500;
    await expect(breaker.exec(fail)).rejects.toThrow('down');
    expect(breaker.current).toBe('open');
    t = 2499;
    expect(breaker.current).toBe('open');
    t = 2500;
    expect(breaker.current).toBe('half_open');
    await expect(breaker.exec(succeed)).resolves.toBe('up');
  });

  it('uses five failures and a 30 second window by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const breaker = new CircuitBreaker('svc');
    for (let i = 0; i < 4; i++) await expect(breaker.exec(fail)).rejects.toThrow();
    expect(breaker.current).toBe('closed');
    await expect(breaker.exec(fail)).rejects.toThrow();
    expect(breaker.current).toBe('open');
    vi.setSystemTime(29_999);
    expect(breaker.current).toBe('open');
    vi.setSystemTime(30_000);
    expect(breaker.current).toBe('half_open');
  });
});

describe('@lite bulkhead', () => {
  it('runs up to the limit at once, queues the next ones and rejects beyond the queue', async () => {
    const bulkhead = new Bulkhead('payments', 2, 1);
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    const started: number[] = [];
    const run = (i: number) =>
      bulkhead.exec(() => {
        started.push(i);
        return gates[i]!.promise;
      });
    const a = run(0);
    const b = run(1);
    const c = run(2);
    expect(started).toEqual([0, 1]);
    expect(bulkhead.inFlight).toBe(2);
    const err = await bulkhead.exec(async () => 99).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'unavailable', message: 'payments is busy, try again' });

    gates[0]!.resolve(0);
    await expect(a).resolves.toBe(0);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    // The queued call took over the released slot.
    expect(bulkhead.inFlight).toBe(2);
    gates[1]!.resolve(1);
    gates[2]!.reject(new Error('gateway error'));
    await expect(b).resolves.toBe(1);
    await expect(c).rejects.toThrow('gateway error');
    expect(bulkhead.inFlight).toBe(0);
    await expect(bulkhead.exec(async () => 'free again')).resolves.toBe('free again');
  });

  it('rejects at once when there is no queue', async () => {
    const bulkhead = new Bulkhead('svc', 1, 0);
    const gate = deferred<void>();
    const first = bulkhead.exec(() => gate.promise);
    await expect(bulkhead.exec(async () => undefined)).rejects.toMatchObject({ code: 'unavailable' });
    gate.resolve();
    await first;
    expect(bulkhead.inFlight).toBe(0);
  });
});
