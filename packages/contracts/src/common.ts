import { z } from 'zod';
import { MAX_PAISE } from './money.js';

export const Uuid = z.uuid();
export const Sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,63}$/, { error: 'SKU must be 2-64 chars of A-Z, 0-9 and dashes' });
export const Slug = z
  .string()
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'Invalid slug' });
export const Language = z.enum(['en', 'hi']);
export type Language = z.infer<typeof Language>;
export const Currency = z.literal('INR');
export type Currency = z.infer<typeof Currency>;

/** Money is always integer paise. ₹1 = 100 paise. Upper bound is ₹1 crore per amount. */
export const Paise = z.number().int().min(0).max(MAX_PAISE);
export const Quantity = z.number().int().min(1).max(1000);
export const IsoDateTime = z.iso.datetime({ offset: true });

export const ErrorCode = z.enum([
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'out_of_stock',
  'price_changed',
  'quote_invalid',
  'quote_expired',
  'quote_used',
  'negotiation_closed',
  'idempotency_conflict',
  'rate_limited',
  'budget_exceeded',
  'payment_failed',
  'amount_mismatch',
  'invalid_signature',
  'illegal_transition',
  'pricing_misconfigured',
  'unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

/** Indian GST state codes. Two-letter code -> numeric code used on invoices. */
export const GST_STATES = {
  JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10',
  SK: '11', AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20',
  OD: '21', CG: '22', MP: '23', GJ: '24', DH: '26', MH: '27', KA: '29', GA: '30', LD: '31', KL: '32',
  TN: '33', PY: '34', AN: '35', TS: '36', AP: '37', LA: '38', OT: '97',
} as const;
export type GstStateCode = keyof typeof GST_STATES;
export const GstStateCode = z.enum(Object.keys(GST_STATES) as [GstStateCode, ...GstStateCode[]]);
