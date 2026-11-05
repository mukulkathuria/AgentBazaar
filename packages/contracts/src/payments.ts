import { z } from 'zod';
import { Currency, Paise, Uuid } from './common.js';

export const PaymentProvider = z.enum(['mock', 'razorpay', 'youpi-pg', 'cod']);
export type PaymentProvider = z.infer<typeof PaymentProvider>;

export const PaymentStatus = z.enum([
  'created',
  'observed',
  'captured',
  'reconciled',
  'failed',
  'refund_pending',
  'refunded',
  'cod_pending',
  'cod_collected',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const PaymentView = z.object({
  paymentId: Uuid,
  orderId: Uuid,
  provider: PaymentProvider,
  status: PaymentStatus,
  amountPaise: Paise,
  currency: Currency,
  paymentUrl: z.string().nullable(),
  providerRef: z.string().nullable(),
  /** Public data the browser needs to open a hosted checkout (e.g. Razorpay key id). */
  clientParams: z.record(z.string(), z.string()),
});
export type PaymentView = z.infer<typeof PaymentView>;

export const MockGatewayAction = z.strictObject({
  outcome: z.enum(['success', 'failure']).default('success'),
});
