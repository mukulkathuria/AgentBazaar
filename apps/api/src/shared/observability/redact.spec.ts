import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findPii, redact, redactDeep } from './redact.js';

describe('@lite PII redaction', () => {
  it.each([
    ['mail me at john.doe+shop@example.co.in', 'mail me at [EMAIL]'],
    ['card 4111 1111 1111 1111 thanks', 'card [CARD] thanks'],
    ['card 4111-1111-1111-1111', 'card [CARD]'],
    ['not a card 4111111111111112', 'not a card 4111111111111112'],
    ['aadhaar 2345 6789 0123', 'aadhaar [AADHAAR]'],
    ['call +91 98765 43210', 'call [PHONE]'],
    ['call +919876543210', 'call [PHONE]'],
    ['call 09876543210', 'call [PHONE]'],
    ['call 98765-43210', 'call [PHONE]'],
    ['PAN ABCDE1234F', 'PAN [PAN]'],
    ['pay ram.k@okhdfc please', 'pay [UPI] please'],
    ['PIN: 560001', '[PINCODE]'],
    ['postal code 400001', '[PINCODE]'],
    ['order 560001 shipped', 'order 560001 shipped'],
    ['no pii here, just a mug for ₹2,399', 'no pii here, just a mug for ₹2,399'],
  ])('%s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('redacts nested JSON values', () => {
    expect(redactDeep({ a: ['x@y.io', { b: 'call 9876543210' }], n: 5 })).toEqual({ a: ['[EMAIL]', { b: 'call [PHONE]' }], n: 5 });
  });

  it('stays linear on hostile 20 KB inputs (no ReDoS)', () => {
    const t0 = performance.now();
    redact('a'.repeat(20_000));
    redact(`pin${' '.repeat(20_000)}x`);
    redact(`${'a.'.repeat(10_000)}@`);
    redact('1 '.repeat(10_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('PROPERTY: generated emails and phones never survive redaction', () => {
    const email = fc
      .tuple(fc.stringMatching(/^[a-z][a-z0-9._]{0,15}$/), fc.stringMatching(/^[a-z]{2,10}\.(com|in|co\.in|org)$/))
      .map(([l, d]) => `${l}@${d}`);
    const phone = fc.stringMatching(/^(\+91 ?|0)?[6-9]\d{9}$/);
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.oneof(email, phone), fc.string({ maxLength: 30 }), (pre, secret, post) => {
        const out = redact(`${pre} ${secret} ${post}`);
        expect(out).not.toContain(secret);
      }),
      { numRuns: 1000 },
    );
    expect(findPii('x@y.io')).toHaveLength(1);
  });
});
