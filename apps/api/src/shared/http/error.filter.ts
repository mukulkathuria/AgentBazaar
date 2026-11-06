import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { ErrorBody, ErrorCode } from '@agentbazaar/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { AppError } from '../kernel/errors.js';
import { isDependencyDown } from '../resilience/resilience.js';
import { issuesOf } from './zod.js';

const BY_STATUS: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'not_found',
  409: 'conflict',
  413: 'validation_failed',
  415: 'validation_failed',
  429: 'rate_limited',
  503: 'unavailable',
};

/** Maps any thrown value to the contract's error envelope. Internals never reach the client. */
export function toErrorResponse(err: unknown, requestId?: string): { status: number; body: ErrorBody; internal: boolean } {
  const withId = (status: number, code: ErrorCode, message: string, details?: unknown) => ({
    status,
    body: { error: { code, message, ...(details === undefined ? {} : { details }), ...(requestId ? { requestId } : {}) } },
    internal: false,
  });
  if (err instanceof AppError) return withId(err.status, err.code, err.message, err.details);
  if (err instanceof ZodError) return withId(400, 'validation_failed', 'Invalid request', issuesOf(err));
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const code = BY_STATUS[status] ?? (status >= 500 ? 'internal' : 'validation_failed');
    return withId(status, code, status === 404 ? 'Route not found' : err.message);
  }
  const statusCode = (err as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    // Fastify's own errors (bad JSON, body too large, unsupported media type, rate limit).
    return withId(statusCode, BY_STATUS[statusCode] ?? 'validation_failed', (err as Error).message);
  }
  if (isDependencyDown(err)) {
    return { ...withId(503, 'unavailable', 'The store is temporarily unavailable. Please try again shortly.'), internal: true };
  }
  return { ...withId(500, 'internal', 'Something went wrong. Please try again.'), internal: true };
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const { status, body, internal } = toErrorResponse(exception, req?.id);
    if (internal) this.logger.error({ err: exception, reqId: req?.id, route: req?.url }, 'unhandled error');
    if (reply.sent) return;
    void reply.status(status).header('cache-control', 'no-store').send(body);
  }
}
