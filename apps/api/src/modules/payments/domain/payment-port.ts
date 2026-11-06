import type { PaymentStatus } from '@agentbazaar/contracts';

export interface PaymentCapabilities {
  /** Gateway confirms payment by itself (webhook), vs. needing manual reconciliation. */
  autoConfirm: boolean;
  refunds: boolean;
  /** Payers that can be served at once; null = unlimited. */
  maxConcurrency: number | null;
}

export interface CreatePaymentInput {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  amountPaise: number;
  currency: 'INR';
  accessToken: string;
}

export interface CreatedPayment {
  providerOrderId: string;
  paymentUrl: string | null;
  clientParams: Record<string, string>;
}

export type WebhookKind = 'captured' | 'failed' | 'observed' | 'reconciled' | 'refunded';

export interface WebhookEvent {
  eventId: string;
  kind: WebhookKind;
  providerOrderId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  currency: string;
  utr: string | null;
}

/** Extension point: add Cashfree, PayU, Stripe... by implementing this. */
export interface PaymentPort {
  readonly name: 'mock' | 'razorpay' | 'youpi-pg';
  readonly capabilities: PaymentCapabilities;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  /** Verifies the signature over the raw body and parses the event. Throws InvalidSignatureError. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): WebhookEvent;
  refund(providerPaymentId: string, amountPaise: number): Promise<{ refundId: string; status: 'pending' | 'processed' }>;
}

export class InvalidSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

const NEXT: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['observed', 'captured', 'reconciled', 'failed'],
  failed: ['observed', 'captured', 'reconciled'],
  observed: ['captured', 'reconciled', 'failed'],
  captured: ['reconciled', 'refund_pending', 'refunded'],
  reconciled: ['refund_pending', 'refunded'],
  refund_pending: ['refunded'],
  refunded: [],
  cod_pending: ['cod_collected'],
  cod_collected: ['refund_pending', 'refunded'],
};

/** Applies an event only if it moves the payment forward; late or replayed events are ignored. */
export function nextPaymentStatus(current: PaymentStatus, kind: WebhookKind): PaymentStatus | null {
  const target: PaymentStatus = kind;
  return NEXT[current].includes(target) ? target : null;
}

export const header = (h: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
