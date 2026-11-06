import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_DISPLAY_CAP, displayQty, normaliseLines } from './stock.js';

describe('@lite stock rules', () => {
  it('shows real stock up to the cap of 50 and never a negative number', () => {
    expect(AVAILABLE_DISPLAY_CAP).toBe(50);
    expect([-3, 0, 1, 49, 50, 51, 10_000].map(displayQty)).toEqual([0, 0, 1, 49, 50, 50, 50]);
  });

  it('merges duplicate variants and orders lines by variant id so locks are always taken in one order', () => {
    expect(
      normaliseLines([
        { variantId: 'b', quantity: 1 },
        { variantId: 'c', quantity: 4 },
        { variantId: 'a', quantity: 2 },
        { variantId: 'b', quantity: 3 },
      ]),
    ).toEqual([
      { variantId: 'a', quantity: 2 },
      { variantId: 'b', quantity: 4 },
      { variantId: 'c', quantity: 4 },
    ]);
    expect(normaliseLines([])).toEqual([]);
  });

  it('rejects zero, negative and fractional quantities', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(() => normaliseLines([{ variantId: 'a', quantity }])).toThrow(new RangeError('Quantity must be a positive integer'));
    }
  });

  it('PROPERTY: keeps every unit of every variant, sorted and unique', () => {
    const line = fc.record({ variantId: fc.constantFrom('a', 'b', 'c', 'd'), quantity: fc.integer({ min: 1, max: 20 }) });
    fc.assert(
      fc.property(fc.array(line, { maxLength: 12 }), (lines) => {
        const out = normaliseLines(lines);
        const ids = out.map((l) => l.variantId);
        expect(ids).toEqual([...new Set(ids)].sort());
        for (const { variantId, quantity } of out) {
          expect(quantity).toBe(lines.filter((l) => l.variantId === variantId).reduce((n, l) => n + l.quantity, 0));
        }
      }),
    );
  });
});
