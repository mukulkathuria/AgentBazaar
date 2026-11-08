import { z } from 'zod';

/** ₹1 crore: the largest amount any contract field carries, so also the largest order. */
export const MAX_PAISE = 1_000_000_000;
const RUPEE_STRING = /^\d{1,8}(?:\.\d{1,2})?$/;

/**
 * Converts a rupee amount (number or decimal string) to integer paise without float drift.
 * Rejects negatives, NaN, more than two decimals and amounts above ₹1 crore.
 */
export function rupeesToPaise(value: number | string): number {
  if (typeof value === 'string') {
    const s = value.trim().replace(/,/g, '');
    if (!RUPEE_STRING.test(s)) throw new RangeError(`Invalid rupee amount: ${value}`);
    const [whole, frac = ''] = s.split('.');
    const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
    if (paise > MAX_PAISE) throw new RangeError('Amount too large');
    return paise;
  }
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid rupee amount: ${value}`);
  const paise = Math.round(value * 100);
  if (Math.abs(value * 100 - paise) > 1e-6) throw new RangeError('At most two decimal places allowed');
  if (paise > MAX_PAISE) throw new RangeError('Amount too large');
  return paise;
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** Decimal string with two places, e.g. 239900 -> "2399.00". Exact for integers. */
export function paiseToDecimalString(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Indian grouping: 12345678 paise -> "₹1,23,456.78"; whole rupees drop the decimals. */
export function formatInr(paise: number, locale: 'en' | 'hi' = 'en'): string {
  const whole = paise % 100 === 0;
  const key = `${locale}:${whole}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    });
    formatters.set(key, f);
  }
  return f.format(paise / 100);
}

/** Agent-facing amount in rupees (number or "2399.50"), parsed to paise. */
export const RupeeAmount = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try {
    return rupeesToPaise(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

/** Structured money for A2A payloads: decimal string avoids float ambiguity across languages. */
export const MoneyDto = z.object({
  amount: z.string().regex(RUPEE_STRING),
  currency: z.literal('INR'),
});
export type MoneyDto = z.infer<typeof MoneyDto>;

export function toMoneyDto(paise: number): MoneyDto {
  return { amount: paiseToDecimalString(paise), currency: 'INR' };
}
