import { describe, expect, it } from 'vitest';
import { AppError } from '../kernel/errors.js';
import { toErrorResponse } from './error.filter.js';

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
