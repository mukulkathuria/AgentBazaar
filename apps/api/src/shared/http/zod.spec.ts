import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../kernel/errors.js';
import { issuesOf, parseOrThrow, ZodPipe } from './zod.js';

const Query = z.strictObject({ limit: z.coerce.number().int().max(100).default(20) });

describe('@lite request validation at the trust boundary', () => {
  it('returns parsed, defaulted values', () => {
    expect(parseOrThrow(Query, { limit: '5' })).toEqual({ limit: 5 });
    expect(new ZodPipe(Query).transform(undefined)).toEqual({ limit: 20 });
  });

  it('fails with a 400 that names what was invalid and lists the issues', () => {
    const err = (() => {
      try {
        new ZodPipe(Query, 'query').transform({ limit: 500, extra: true });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'validation_failed', status: 400, message: 'Invalid query' });
    expect((err as AppError).details).toEqual([
      { path: 'limit', message: expect.any(String) },
      { path: '', message: expect.stringContaining('extra') },
    ]);
    expect(() => parseOrThrow(Query, { limit: 'x' })).toThrow('Invalid request');
  });

  it('rejects a NUL character anywhere in the input, which Postgres text and jsonb cannot store', () => {
    const Any = z.record(z.string(), z.unknown());
    expect(() => parseOrThrow(Any, { q: 'ab\u0000c' })).toThrow(AppError);
    expect(() => parseOrThrow(Any, { a: [{ b: ['ok', 'x\u0000'] }] })).toThrow('Invalid request');
    expect(() => parseOrThrow(Any, { 'k\u0000': 1 })).toThrow(AppError);
    // Deep nesting is walked iteratively, so it cannot overflow the stack.
    let deep: unknown = 'end\u0000';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(() => parseOrThrow(Any, { deep })).toThrow(AppError);
    expect(parseOrThrow(Any, { q: 'a literal \\u0000 escape is fine' })).toEqual({ q: 'a literal \\u0000 escape is fine' });
  });

  it('caps the issue list at 20 and joins nested paths with dots', () => {
    const Many = z.array(z.object({ a: z.object({ b: z.string() }) }));
    const r = Many.safeParse(Array.from({ length: 30 }, () => ({ a: { b: 1 } })));
    expect(r.success).toBe(false);
    const issues = issuesOf(r.error!);
    expect(issues).toHaveLength(20);
    expect(issues[3]!.path).toBe('3.a.b');
  });
});
