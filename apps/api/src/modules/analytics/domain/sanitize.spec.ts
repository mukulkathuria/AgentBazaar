import { describe, expect, it } from 'vitest';
import { cleanPath, sanitizeEventData } from './sanitize.js';

describe('@lite analytics event hygiene', () => {
  it('redacts personal data and truncates strings to 100 characters', () => {
    const out = sanitizeEventData({
      q: 'mugs for priya@example.com call 9876543210',
      long: 'x'.repeat(500),
      total: 3,
      ok: true,
      none: null,
    });
    expect(out).toEqual({ q: 'mugs for [EMAIL] call [PHONE]', long: 'x'.repeat(100), total: 3, ok: true, none: null });
  });

  it('keeps data flat and finite', () => {
    expect(sanitizeEventData({ nested: { email: 'a@b.co' }, list: [1], nan: NaN, inf: Infinity, fn: () => 1 })).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeEventData(many))).toHaveLength(20);
  });

  it('drops query strings and fragments from paths', () => {
    expect(cleanPath('/checkout/abc?t=secret-token#pay')).toBe('/checkout/abc');
    expect(cleanPath('/u/priya@example.com')).toBe('/u/[EMAIL]');
    expect(cleanPath(`/${'p'.repeat(400)}`)).toHaveLength(200);
  });
});
