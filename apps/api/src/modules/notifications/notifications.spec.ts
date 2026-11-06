import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/observability/logger.js';
import { findPii } from '../../shared/observability/redact.js';
import { orderEmailFor } from './domain/mailer.js';
import { LogMailer } from './infrastructure/log-mailer.js';

describe('@lite order notifications', () => {
  it('builds emails only from known order events with an order number and customer token', () => {
    const payload = { number: 'AB-1001', customerToken: 'cus_abc', email: 'asha@example.com', name: 'Asha' };
    expect(orderEmailFor('order.paid', payload)).toEqual({
      template: 'order.paid',
      orderNumber: 'AB-1001',
      customerToken: 'cus_abc',
    });
    expect(orderEmailFor('order.cancelled', payload)).toBeNull();
    expect(orderEmailFor('order.paid', { number: 7, customerToken: 'cus_abc' })).toBeNull();
  });

  it('logs the template, order number and customer token, and nothing personal', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const mail = orderEmailFor('order.created', {
      number: 'AB-1002',
      customerToken: 'cus_xyz',
      email: 'asha@example.com',
      phone: '9876543210',
    });
    await new LogMailer(createLogger('info', sink)).send(mail!);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      template: 'order.created',
      orderNumber: 'AB-1002',
      customerToken: 'cus_xyz',
    });
    expect(findPii(lines.join('\n'))).toEqual([]);
  });
});
