import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, NestPinoLogger } from './logger.js';

/** A pino destination that keeps every line as parsed JSON. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
      done();
    },
  });
  return { lines, stream };
}

describe('@lite structured logging without personal data', () => {
  it('tags every line with the service and honours the level', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.debug('hidden');
    log.info('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'agentbazaar-api', msg: 'shown', level: 30 });
  });

  it('censors secret headers and personal fields by path', () => {
    const { lines, stream } = capture();
    createLogger('info', stream).info(
      {
        req: { headers: { authorization: 'Bearer abc.def', cookie: 'sid=1', 'x-razorpay-signature': 'sig', accept: 'json' } },
        body: { email: 'a@b.co', password: 'pw', token: 't', refreshToken: 'r', clientSecret: 's', sku: 'KB-1' },
      },
      'request',
    );
    const line = lines[0] as { req: { headers: Record<string, string> }; body: Record<string, string> };
    expect(line.req.headers).toEqual({ authorization: '[REDACTED]', cookie: '[REDACTED]', 'x-razorpay-signature': '[REDACTED]', accept: 'json' });
    expect(line.body).toEqual({
      email: '[REDACTED]',
      password: '[REDACTED]',
      token: '[REDACTED]',
      refreshToken: '[REDACTED]',
      clientSecret: '[REDACTED]',
      sku: 'KB-1',
    });
  });

  it('scrubs personal data out of free-text messages and errors, leaving other arguments alone', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.info('order for asha.verma@example.com, call 9876543210');
    log.info({ n: 1 }, 'count %d', 5);
    log.error({ err: new Error('lookup failed for asha.verma@example.com') }, 'failed');
    expect(lines[0]!.msg).toBe('order for [EMAIL], call [PHONE]');
    expect(lines[1]).toMatchObject({ n: 1, msg: 'count 5' });
    expect(lines[2]!.err).toMatchObject({ type: 'Error', message: 'lookup failed for [EMAIL]' });
    expect(String((lines[2]!.err as { stack: string }).stack)).not.toContain('asha.verma@example.com');
  });

  it('serializes errors without a stack', () => {
    const { lines, stream } = capture();
    const err = new Error('no stack');
    err.stack = undefined;
    createLogger('info', stream).error({ err }, 'x');
    expect(lines[0]!.err).toEqual({ type: 'Error', message: 'no stack' });
  });

  it('routes Nest framework logs through the same redacting logger at matching levels', () => {
    const { lines, stream } = capture();
    const nest = new NestPinoLogger(createLogger('trace', stream));
    nest.log('started', 'App');
    nest.error('crashed for 9876543210', 'Error: at handler (asha@example.com)', 'Router');
    nest.error('no trace');
    nest.warn('slow', 'Db');
    nest.debug(42, 'Cache');
    nest.verbose('chatty', 'Http');
    expect(lines.map((l) => [l.level, l.msg, l.context])).toEqual([
      [30, 'started', 'App'],
      [50, 'crashed for [PHONE]', 'Router'],
      [50, 'no trace', undefined],
      [40, 'slow', 'Db'],
      [20, '42', 'Cache'],
      [10, 'chatty', 'Http'],
    ]);
    expect(lines[1]!.trace).toBe('Error: at handler ([EMAIL])');
    expect(lines[2]).not.toHaveProperty('trace');
  });
});
