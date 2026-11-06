import { PaymentStatus } from '@agentbazaar/contracts';
import { describe, expect, it } from 'vitest';
import { header, InvalidSignatureError, nextPaymentStatus, type WebhookKind } from './payment-port.js';

const KINDS: WebhookKind[] = ['captured', 'failed', 'observed', 'reconciled', 'refunded'];

describe('@lite payment status progression', () => {
  it('applies a webhook only when it moves the payment forward', () => {
    // Written out in full so any change to what a webhook may do is a deliberate one.
    const FORWARD: Record<PaymentStatus, WebhookKind[]> = {
      created: ['captured', 'failed', 'observed', 'reconciled'],
      failed: ['captured', 'observed', 'reconciled'],
      observed: ['captured', 'failed', 'reconciled'],
      captured: ['reconciled', 'refunded'],
      reconciled: ['refunded'],
      refund_pending: ['refunded'],
      refunded: [],
      cod_pending: [],
      cod_collected: ['refunded'],
    };
    for (const status of PaymentStatus.options) {
      for (const kind of KINDS) {
        expect({ status, kind, next: nextPaymentStatus(status, kind) }).toEqual({
          status,
          kind,
          next: FORWARD[status].includes(kind) ? kind : null,
        });
      }
    }
  });

  it('ignores replayed and late events', () => {
    expect(nextPaymentStatus('captured', 'captured')).toBeNull();
    expect(nextPaymentStatus('refunded', 'captured')).toBeNull();
    expect(nextPaymentStatus('captured', 'failed')).toBeNull();
  });

  it('reads a header case-insensitively and takes the first of repeated values', () => {
    const h = { 'x-signature': 'abc', 'x-multi': ['first', 'second'] };
    expect(header(h, 'X-Signature')).toBe('abc');
    expect(header(h, 'x-multi')).toBe('first');
    expect(header(h, 'x-missing')).toBeUndefined();
  });

  it('has a named signature error with a default message', () => {
    expect(new InvalidSignatureError()).toMatchObject({ name: 'InvalidSignatureError', message: 'Invalid webhook signature' });
    expect(new InvalidSignatureError('stale').message).toBe('stale');
  });
});
