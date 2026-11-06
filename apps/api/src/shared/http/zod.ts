import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from '../kernel/errors.js';

export function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Postgres text and jsonb cannot hold U+0000, so a NUL that got past validation failed later as a 500. */
function hasNul(value: unknown): boolean {
  const stack = [value]; // iterative: arbitrarily deep JSON cannot overflow the call stack
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.includes('\u0000')) return true;
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k.includes('\u0000')) return true;
        stack.push(x);
      }
    }
  }
  return false;
}

export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what = 'request'): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('validation_failed', `Invalid ${what}`, issuesOf(r.error));
  if (hasNul(r.data)) throw new AppError('validation_failed', `Invalid ${what}`, [{ path: '', message: 'Text cannot contain NUL characters' }]);
  return r.data;
}

/** Validates a controller argument against a contract schema. Unknown keys fail on strict schemas. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(
    private readonly schema: S,
    private readonly what = 'request',
  ) {}
  transform(value: unknown): z.output<S> {
    return parseOrThrow(this.schema, value ?? {}, this.what);
  }
}
