export interface TaxLine {
  kind: 'CGST' | 'SGST' | 'IGST';
  rateBps: number;
  amountPaise: number;
}

export interface LineTax {
  taxablePaise: number;
  taxes: TaxLine[];
  taxPaise: number;
}

/**
 * Splits a GST-inclusive line total into taxable value and tax. Tax is total minus taxable, so the
 * parts always add up to the exact total. Intra-state: CGST + SGST halves; inter-state: IGST.
 */
export function gstForLine(totalInclusivePaise: number, rateBps: number, intraState: boolean): LineTax {
  if (!Number.isInteger(totalInclusivePaise) || totalInclusivePaise < 0) throw new RangeError('Line total must be non-negative paise');
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) throw new RangeError('GST rate out of range');
  const taxable = Math.round((totalInclusivePaise * 10_000) / (10_000 + rateBps));
  const tax = totalInclusivePaise - taxable;
  if (!intraState) return { taxablePaise: taxable, taxPaise: tax, taxes: [{ kind: 'IGST', rateBps, amountPaise: tax }] };
  const central = Math.floor(tax / 2);
  return {
    taxablePaise: taxable,
    taxPaise: tax,
    taxes: [
      { kind: 'CGST', rateBps: rateBps / 2, amountPaise: central },
      { kind: 'SGST', rateBps: rateBps / 2, amountPaise: tax - central },
    ],
  };
}

/** Indian financial year (April to March) in IST, e.g. 5 Nov 2026 -> "2026-27". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const invoiceNumber = (fy: string, n: number): string => `INV/${fy}/${String(n).padStart(6, '0')}`;
