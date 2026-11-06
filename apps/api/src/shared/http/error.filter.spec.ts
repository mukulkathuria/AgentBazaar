import { type ArgumentsHost, HttpException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../kernel/errors.js';
import { ErrorFilter, toErrorResponse } from './error.filter.js';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('toErrorResponse for unreachable dependencies', () => {
  // Regression: a database or cache outage answered 500 "internal" instead of 503 "unavailable".
  it.each([
    ['refused connection', withCode('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED')],
    ['reset connection', withCode('read ECONNRESET', 'ECONNRESET')],
    [
      'Postgres failover (admin shutdown)',
      withCode('terminating connection due to administrator command', '57P01'),
    ],
    ['lost Postgres connection', withCode('connection failure', '08006')],
    ['statement timeout', withCode('canceling statement due to statement timeout', '57014')],
    ['pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['dropped connection', new Error('Connection terminated unexpectedly')],
    ['client-side query timeout', new Error('Query read timeout')],
    [
      'disconnected Valkey client',
      new Error("Stream isn't writeable and enableOfflineQueue options is false"),
    ],
    [
      'driver error wrapped by the query builder',
      new Error('Failed query: SELECT 1', { cause: new Error('Connection terminated unexpectedly') }),
    ],
  ])('maps a %s to 503 without leaking it', (_, err) => {
    const { status, body, internal } = toErrorResponse(err, 'req-1');
    expect(status).toBe(503);
    expect(body).toEqual({ error: { code: 'unavailable', message: expect.any(String), requestId: 'req-1' } });
    expect(JSON.stringify(body)).not.toMatch(/ECONN|5432|terminat|statement|Stream|SELECT/i);
    expect(internal).toBe(true); // still logged
  });

  it.each([
    ['plain bug', new Error('Cannot read properties of undefined')],
    ['unique violation', withCode('duplicate key value violates unique constraint', '23505')],
    ['unknown code', withCode('something odd', 'EWHATEVER')],
  ])('keeps a %s a generic 500', (_, err) => {
    expect(toErrorResponse(err)).toMatchObject({
      status: 500,
      body: { error: { code: 'internal' } },
      internal: true,
    });
  });

  it('leaves expected application errors alone', () => {
    expect(toErrorResponse(new AppError('out_of_stock', 'Only 2 left'))).toMatchObject({
      status: 409,
      body: { error: { code: 'out_of_stock', message: 'Only 2 left' } },
      internal: false,
    });
  });
});

describe('@lite error envelope', () => {
  it('passes AppErrors through with their status, details and the request id', () => {
    expect(toErrorResponse(new AppError('out_of_stock', 'Gone', { sku: 'X' }), 'req-1')).toEqual({
      status: 409,
      body: { error: { code: 'out_of_stock', message: 'Gone', details: { sku: 'X' }, requestId: 'req-1' } },
      internal: false,
    });
    // No details and no request id: neither key appears.
    expect(toErrorResponse(notFound('Order')).body).toEqual({ error: { code: 'not_found', message: 'Order not found' } });
    expect(toErrorResponse(forbidden()).body.error).toEqual({ code: 'forbidden', message: 'Not allowed' });
    expect(toErrorResponse(forbidden('Admins only')).status).toBe(403);
  });

  it('turns schema failures into a 400 listing each issue path', () => {
    const r = z.object({ qty: z.number(), sku: z.string() }).safeParse({ qty: 'x' });
    expect(r.success).toBe(false);
    const res = toErrorResponse(r.error);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toBe('Invalid request');
    expect((res.body.error.details as { path: string }[]).map((d) => d.path)).toEqual(['qty', 'sku']);
  });

  it('maps framework HTTP exceptions by status, hiding unknown routes behind one message', () => {
    expect(toErrorResponse(new NotFoundException('Cannot GET /secret')).body.error).toEqual({ code: 'not_found', message: 'Route not found' });
    expect(toErrorResponse(new HttpException('Method not allowed', 405)).body.error).toEqual({ code: 'not_found', message: 'Method not allowed' });
    expect(toErrorResponse(new PayloadTooLargeException('Too big')).body.error.code).toBe('validation_failed');
    expect(toErrorResponse(new HttpException('Teapot', 418))).toMatchObject({ status: 418, body: { error: { code: 'validation_failed' } }, internal: false });
    expect(toErrorResponse(new HttpException('Bad gateway', 502))).toMatchObject({ status: 502, body: { error: { code: 'internal' } } });
    expect(toErrorResponse(new HttpException('Busy', 503)).body.error.code).toBe('unavailable');
  });

  it("keeps Fastify's own 4xx errors (bad JSON, rate limit) and their message", () => {
    const fastifyError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
    expect(toErrorResponse(fastifyError(429, 'Rate limit exceeded'))).toEqual({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'Rate limit exceeded' } },
      internal: false,
    });
    expect(toErrorResponse(fastifyError(415, 'Unsupported Media Type')).body.error.code).toBe('validation_failed');
    expect(toErrorResponse(fastifyError(422, 'Unprocessable')).body.error.code).toBe('validation_failed');
    expect(toErrorResponse(fastifyError(400, 'Body is not valid JSON')).status).toBe(400);
  });

  it('never leaks internals: anything else is a generic 500 flagged for logging', () => {
    const generic = { status: 500, body: { error: { code: 'internal', message: 'Something went wrong. Please try again.' } }, internal: true };
    expect(toErrorResponse(new Error('bad password for user admin'))).toEqual(generic);
    expect(toErrorResponse(Object.assign(new Error('5xx from upstream'), { statusCode: 500 }))).toEqual(generic);
    expect(toErrorResponse(Object.assign(new Error('odd'), { statusCode: 399 }))).toEqual(generic);
    expect(toErrorResponse(Object.assign(new Error('odd'), { statusCode: '404' }))).toEqual(generic);
    expect(toErrorResponse('a string')).toEqual(generic);
    expect(toErrorResponse(null)).toEqual(generic);
    expect(toErrorResponse(undefined, 'req-9').body.error.requestId).toBe('req-9');
  });
});

describe('@lite error filter', () => {
  function host(sent = false) {
    const reply = { sent, status: vi.fn(), header: vi.fn(), send: vi.fn() };
    reply.status.mockReturnValue(reply);
    reply.header.mockReturnValue(reply);
    const req = { id: 'req-7', url: '/api/v1/orders' };
    const h = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }) } as unknown as ArgumentsHost;
    return { h, reply };
  }
  const logger = () => ({ error: vi.fn() }) as unknown as Logger & { error: ReturnType<typeof vi.fn> };

  it('sends the envelope uncached and does not log expected errors', () => {
    const log = logger();
    const { h, reply } = host();
    new ErrorFilter(log).catch(new AppError('conflict', 'Busy'), h);
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.header).toHaveBeenCalledWith('cache-control', 'no-store');
    expect(reply.send).toHaveBeenCalledWith({ error: { code: 'conflict', message: 'Busy', requestId: 'req-7' } });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs unexpected errors with the request context', () => {
    const log = logger();
    const { h, reply } = host();
    const boom = new Error('boom');
    new ErrorFilter(log).catch(boom, h);
    expect(log.error).toHaveBeenCalledWith({ err: boom, reqId: 'req-7', route: '/api/v1/orders' }, 'unhandled error');
    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it('does not write to a reply that was already sent', () => {
    const log = logger();
    const { h, reply } = host(true);
    new ErrorFilter(log).catch(new Error('late'), h);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
