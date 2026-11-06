import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { financialYear, gstForLine, invoiceNumber } from './gst.js';

describe('@lite GST', () => {
  it('splits an 18% inclusive price intra-state into CGST and SGST', () => {
    const t = gstForLine(549_900, 1800, true);
    expect(t.taxablePaise).toBe(466_017);
    expect(t.taxes).toEqual([
      { kind: 'CGST', rateBps: 900, amountPaise: 41_941 },
      { kind: 'SGST', rateBps: 900, amountPaise: 41_942 },
    ]);
  });

  it('uses IGST inter-state', () => {
    expect(gstForLine(2000, 500, false).taxes).toEqual([{ kind: 'IGST', rateBps: 500, amountPaise: 95 }]);
  });

  it('PROPERTY: parts always add up to the exact inclusive total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.constantFrom(0, 300, 500, 1200, 1800, 2800, 4000),
        fc.boolean(),
        (total, rate, intra) => {
          const t = gstForLine(total, rate, intra);
          expect(t.taxablePaise + t.taxes.reduce((a, x) => a + x.amountPaise, 0)).toBe(total);
          expect(t.taxPaise).toBeGreaterThanOrEqual(0);
          for (const x of t.taxes) expect(x.amountPaise).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('rejects invalid inputs', () => {
    expect(() => gstForLine(-1, 1800, true)).toThrow(RangeError);
    expect(() => gstForLine(100, 10_001, true)).toThrow(RangeError);
  });

  it('numbers invoices by Indian financial year in IST', () => {
    expect(financialYear(new Date('2026-11-05T10:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T18:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T18:31:00Z'))).toBe('2027-28');
    expect(invoiceNumber('2026-27', 42)).toBe('INV/2026-27/000042');
  });
});
