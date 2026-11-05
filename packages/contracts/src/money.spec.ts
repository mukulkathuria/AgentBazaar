import { describe, expect, it } from 'vitest';
import { formatInr, paiseToDecimalString, rupeesToPaise, RupeeAmount, toMoneyDto } from './money.js';

describe('@lite money', () => {
  it.each([
    [2399, 239_900],
    ['2399.5', 239_950],
    ['2,399.05', 239_905],
    [0.1, 10],
    [19.99, 1999],
    ['0', 0],
  ])('rupeesToPaise(%s) = %s', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.005, '12.345', 'abc', '-5', '1e5', '', 20_000_000])(
    'rejects %s',
    (input) => {
      expect(() => rupeesToPaise(input)).toThrow(RangeError);
    },
  );

  it('formats with Indian grouping and drops zero paise', () => {
    expect(formatInr(12_345_678)).toBe('₹1,23,456.78');
    expect(formatInr(239_900)).toBe('₹2,399');
    expect(formatInr(2000)).toBe('₹20');
  });

  it('decimal strings are exact', () => {
    expect(paiseToDecimalString(239_905)).toBe('2399.05');
    expect(paiseToDecimalString(5)).toBe('0.05');
    expect(toMoneyDto(100)).toEqual({ amount: '1.00', currency: 'INR' });
  });

  it('round-trips every paise value in a range', () => {
    for (let p = 0; p < 20_000; p += 7) expect(rupeesToPaise(paiseToDecimalString(p))).toBe(p);
  });

  it('RupeeAmount schema reports a validation issue instead of throwing', () => {
    expect(RupeeAmount.safeParse('12.345').success).toBe(false);
    expect(RupeeAmount.parse('12.34')).toBe(1234);
  });
});
