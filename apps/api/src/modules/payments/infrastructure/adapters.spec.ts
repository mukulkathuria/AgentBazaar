import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidSignatureError } from '../domain/payment-port.js';
import { RazorpayAdapter } from './adapters.js';

const SECRET = 'whsec_test';
const razorpay = new RazorpayAdapter('rzp_test_key', 'key_secret', SECRET);
const payment = { id: 'pay_1', order_id: 'order_1', amount: 52_900, currency: 'INR', acquirer_data: { rrn: '412345678901' } };
const captured = { event: 'payment.captured', payload: { payment: { entity: payment } } };

/** A webhook as Razorpay would deliver it: the raw body plus its HMAC signature and event id headers. */
function signed(body: unknown, eventId?: string) {
  const raw = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = { 'x-razorpay-signature': createHmac('sha256', SECRET).update(raw).digest('hex') };
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  return [raw, headers] as const;
}

describe('RazorpayAdapter.parseWebhook', () => {
  it('maps a captured payment', () => {
    expect(razorpay.parseWebhook(...signed(captured, 'evt_1'))).toEqual({
      eventId: 'evt_1',
      kind: 'captured',
      providerOrderId: 'order_1',
      providerPaymentId: 'pay_1',
      amountPaise: 52_900,
      currency: 'INR',
      utr: '412345678901',
    });
  });

  it('takes a refund amount from the refund entity, falling back to the payment amount', () => {
    const partial = { event: 'refund.processed', payload: { payment: { entity: payment }, refund: { entity: { amount: 10_000 } } } };
    const whole = { event: 'refund.processed', payload: { payment: { entity: payment } } };
    expect(razorpay.parseWebhook(...signed(partial, 'evt_2'))).toMatchObject({ kind: 'refunded', amountPaise: 10_000 });
    expect(razorpay.parseWebhook(...signed(whole, 'evt_3'))).toMatchObject({ kind: 'refunded', amountPaise: 52_900 });
  });

  it('defaults the currency and leaves missing payment id and UTR null', () => {
    const bare = { event: 'payment.failed', payload: { payment: { entity: { order_id: 'order_2', amount: 100 } } } };
    expect(razorpay.parseWebhook(...signed(bare, 'evt_4'))).toEqual({
      eventId: 'evt_4',
      kind: 'failed',
      providerOrderId: 'order_2',
      providerPaymentId: null,
      amountPaise: 100,
      currency: 'INR',
      utr: null,
    });
  });

  it('refuses unsupported, incomplete or unidentified events', () => {
    const refused = [
      signed({ ...captured, event: 'order.paid' }, 'evt_5'),
      signed({ ...captured, payload: { payment: { entity: { ...payment, order_id: undefined } } } }, 'evt_6'),
      signed({ ...captured, payload: { payment: { entity: { ...payment, amount: '52900' } } } }, 'evt_7'),
      signed({ ...captured, payload: {} }, 'evt_8'),
      signed(captured),
    ];
    for (const [raw, headers] of refused) expect(() => razorpay.parseWebhook(raw, headers)).toThrow(InvalidSignatureError);
  });

  it('refuses a bad signature before reading the body', () => {
    const [raw, headers] = signed(captured, 'evt_9');
    expect(() => razorpay.parseWebhook(raw, { ...headers, 'x-razorpay-signature': 'f'.repeat(64) })).toThrow(InvalidSignatureError);
    expect(() => razorpay.parseWebhook(Buffer.from('not json'), {})).toThrow(InvalidSignatureError);
  });
});
