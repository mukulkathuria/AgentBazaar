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

  it('names what is wrong, and accepts the edges of the valid range', () => {
    for (const total of [-1, 10.5, Number.NaN]) {
      expect(() => gstForLine(total, 1800, true)).toThrow(new RangeError('Line total must be non-negative paise'));
    }
    for (const rate of [-1, 10_001, 12.5]) {
      expect(() => gstForLine(100, rate, false)).toThrow(new RangeError('GST rate out of range'));
    }
    expect(gstForLine(0, 1800, true)).toEqual({ taxablePaise: 0, taxPaise: 0, taxes: [{ kind: 'CGST', rateBps: 900, amountPaise: 0 }, { kind: 'SGST', rateBps: 900, amountPaise: 0 }] });
    // 100% is the highest rate allowed: half of an inclusive 200 is tax.
    expect(gstForLine(200, 10_000, false)).toEqual({ taxablePaise: 100, taxPaise: 100, taxes: [{ kind: 'IGST', rateBps: 10_000, amountPaise: 100 }] });
    expect(gstForLine(118, 0, false).taxPaise).toBe(0);
  });

  it('pads the second half of the financial year to two digits across a century', () => {
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('2099-00');
    expect(financialYear(new Date('2108-06-01T00:00:00Z'))).toBe('2108-09');
  });

  it('numbers invoices by Indian financial year in IST', () => {
    expect(financialYear(new Date('2026-11-05T10:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T18:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T18:31:00Z'))).toBe('2027-28');
    expect(invoiceNumber('2026-27', 42)).toBe('INV/2026-27/000042');
  });
});
