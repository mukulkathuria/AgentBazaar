import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from '../kernel/errors.js';

export function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, what = 'request'): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError('validation_failed', `Invalid ${what}`, issuesOf(r.error));
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
