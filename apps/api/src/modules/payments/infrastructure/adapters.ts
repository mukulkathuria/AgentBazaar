import { createHmac, randomUUID } from 'node:crypto';
import { safeEqual } from '../../../shared/crypto/primitives.js';
import { CircuitBreaker, withTimeout } from '../../../shared/resilience/resilience.js';
import {
  type CreatedPayment,
  type CreatePaymentInput,
  header,
  InvalidSignatureError,
  type PaymentPort,
  type WebhookEvent,
  type WebhookKind,
} from '../domain/payment-port.js';

const hmacHex = (secret: string, raw: Buffer | string) => createHmac('sha256', secret).update(raw).digest('hex');

function verifyHex(secret: string, raw: Buffer, signature: string | undefined): void {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature) || !safeEqual(hmacHex(secret, raw), signature.toLowerCase())) {
    throw new InvalidSignatureError();
  }
}

function parseJson(raw: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new InvalidSignatureError('Webhook body is not JSON');
  }
}

interface RazorpayPayment {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  acquirer_data?: { rrn?: string };
}

interface RazorpayWebhookBody {
  event?: string;
  payload?: { payment?: { entity?: RazorpayPayment }; refund?: { entity?: { amount?: number } } };
}

/** Flattens the nested Razorpay webhook payload into the fields we use. */
function razorpayPayload(b: RazorpayWebhookBody) {
  const p: RazorpayPayment = b.payload?.payment?.entity ?? {};
  return {
    orderId: p.order_id,
    paymentId: p.id ?? null,
    amount: p.amount,
    refundAmount: b.payload?.refund?.entity?.amount,
    currency: p.currency ?? 'INR',
    utr: p.acquirer_data?.rrn ?? null,
  };
}

/**
 * Default adapter: imitates Razorpay's flow (order, hosted page, signed webhook, refunds) with no
 * network and no keys. Used by the demo and every test.
 */
export class MockPaymentAdapter implements PaymentPort {
  readonly name = 'mock' as const;
  readonly capabilities = { autoConfirm: true, refunds: true, maxConcurrency: null };

  constructor(
    private readonly secret: string,
    private readonly webBaseUrl: string,
  ) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    return {
      providerOrderId: `order_mock_${input.paymentId.replace(/-/g, '').slice(0, 16)}`,
      paymentUrl: `${this.webBaseUrl}/pay/mock/${input.paymentId}?t=${encodeURIComponent(input.accessToken)}`,
      clientParams: {},
    };
  }

  /** What the mock gateway would POST to our webhook endpoint. */
  signedEvent(e: { kind: WebhookKind; providerOrderId: string; amountPaise: number; currency?: string; eventId?: string }): {
    raw: Buffer;
    headers: Record<string, string>;
  } {
    const body = {
      event_id: e.eventId ?? `evt_mock_${randomUUID()}`,
      event: e.kind === 'refunded' ? 'refund.processed' : `payment.${e.kind}`,
      payload: {
        order_id: e.providerOrderId,
        payment_id: `pay_mock_${e.providerOrderId.slice(-8)}`,
        amount: e.amountPaise,
        currency: e.currency ?? 'INR',
      },
    };
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, headers: { 'x-mock-signature': hmacHex(this.secret, raw) } };
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    verifyHex(this.secret, raw, header(headers, 'x-mock-signature'));
    const b = parseJson(raw) as {
      event_id?: string;
      event?: string;
      payload?: { order_id?: string; payment_id?: string; amount?: number; currency?: string };
    };
    const kinds: Record<string, WebhookKind> = { 'payment.captured': 'captured', 'payment.failed': 'failed', 'refund.processed': 'refunded' };
    const kind = kinds[b.event ?? ''];
    if (!kind || !b.event_id || !b.payload?.order_id || typeof b.payload.amount !== 'number') {
      throw new InvalidSignatureError('Malformed mock event');
    }
    return {
      eventId: b.event_id,
      kind,
      providerOrderId: b.payload.order_id,
      providerPaymentId: b.payload.payment_id ?? null,
      amountPaise: b.payload.amount,
      currency: b.payload.currency ?? 'INR',
      utr: null,
    };
  }

  async refund(providerPaymentId: string): Promise<{ refundId: string; status: 'processed' }> {
    return { refundId: `rfnd_mock_${providerPaymentId.slice(-8)}`, status: 'processed' };
  }
}

/**
 * Razorpay, the first licensed adapter. Written from Razorpay's public API docs and unit-tested
 * against recorded fixtures. NOT yet verified against the live sandbox: that is a human step once
 * test keys exist.
 */
export class RazorpayAdapter implements PaymentPort {
  readonly name = 'razorpay' as const;
  readonly capabilities = { autoConfirm: true, refunds: true, maxConcurrency: null };
  private readonly breaker = new CircuitBreaker('razorpay', 5, 30_000);

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.razorpay.com/v1',
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.breaker.exec(() =>
      withTimeout(async (signal) => {
        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw new Error(`Razorpay ${path} failed with ${res.status}`);
        return (await res.json()) as T;
      }, 8000),
    );
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const order = await this.post<{ id: string }>('/orders', {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.orderNumber,
      notes: { payment_id: input.paymentId },
    });
    return {
      providerOrderId: order.id,
      paymentUrl: null,
      clientParams: { key: this.keyId, order_id: order.id, amount: String(input.amountPaise), currency: input.currency },
    };
  }

  /** Verifies the Checkout.js callback: HMAC(order_id|payment_id, key_secret). */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    return /^[0-9a-f]{64}$/i.test(signature) && safeEqual(hmacHex(this.keySecret, `${orderId}|${paymentId}`), signature.toLowerCase());
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    verifyHex(this.webhookSecret, raw, header(headers, 'x-razorpay-signature'));
    const eventId = header(headers, 'x-razorpay-event-id');
    const b = parseJson(raw) as RazorpayWebhookBody;
    const kinds: Record<string, WebhookKind> = { 'payment.captured': 'captured', 'payment.failed': 'failed', 'refund.processed': 'refunded' };
    const kind = kinds[b.event ?? ''];
    const p = razorpayPayload(b);
    if (!kind || !eventId || !p.orderId || typeof p.amount !== 'number') throw new InvalidSignatureError('Unsupported Razorpay event');
    return {
      eventId,
      kind,
      providerOrderId: p.orderId,
      providerPaymentId: p.paymentId,
      amountPaise: kind === 'refunded' ? (p.refundAmount ?? p.amount) : p.amount,
      currency: p.currency,
      utr: p.utr,
    };
  }

  async refund(providerPaymentId: string, amountPaise: number): Promise<{ refundId: string; status: 'pending' | 'processed' }> {
    const r = await this.post<{ id: string; status: string }>(`/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
      amount: amountPaise,
    });
    return { refundId: r.id, status: r.status === 'processed' ? 'processed' : 'pending' };
  }
}

/**
 * YouPI-PG, EXPERIMENTAL: a self-hosted UPI gateway that detects payments from bank alerts. Its
 * own README says it is not bank-approved or audited. The REST/webhook shapes here are our
 * assumptions from its documentation summary and must be confirmed against its OpenAPI file.
 * OBSERVED_SUCCESS is not settlement; only RECONCILED (from an imported bank statement) is.
 */
export class YoupiPgAdapter implements PaymentPort {
  readonly name = 'youpi-pg' as const;
  readonly capabilities = { autoConfirm: false, refunds: false, maxConcurrency: 1 };
  private readonly breaker = new CircuitBreaker('youpi-pg', 3, 30_000);
  static readonly MAX_SKEW_S = 3600;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly webhookSecret: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const created = await this.breaker.exec(() =>
      withTimeout(async (signal) => {
        const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, '')}/api/v1/payments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify({ amount_paise: input.amountPaise, currency: input.currency, reference: input.paymentId }),
          signal,
        });
        if (!res.ok) throw new Error(`YouPI-PG create failed with ${res.status}`);
        return (await res.json()) as { id: string; payment_url?: string; upi_uri?: string };
      }, 8000),
    );
    return {
      providerOrderId: created.id,
      paymentUrl: created.payment_url ?? null,
      clientParams: created.upi_uri ? { upi_uri: created.upi_uri } : {},
    };
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): WebhookEvent {
    verifyHex(this.webhookSecret, raw, header(headers, 'x-youpi-signature'));
    const delivery = header(headers, 'x-youpi-delivery-id');
    const ts = Number(header(headers, 'x-youpi-timestamp'));
    // Its retry window is one hour, so older deliveries are replays and are refused.
    if (!delivery || !Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > YoupiPgAdapter.MAX_SKEW_S) {
      throw new InvalidSignatureError('Stale or unidentified delivery');
    }
    const b = parseJson(raw) as { id?: string; status?: string; amount_paise?: number; currency?: string; utr?: string };
    const kinds: Record<string, WebhookKind> = { OBSERVED_SUCCESS: 'observed', RECONCILED: 'reconciled', FAILED: 'failed', EXPIRED: 'failed' };
    const kind = kinds[b.status ?? ''];
    if (!kind || !b.id || typeof b.amount_paise !== 'number') throw new InvalidSignatureError('Unsupported YouPI-PG event');
    if ((kind === 'observed' || kind === 'reconciled') && !b.utr) throw new InvalidSignatureError('Missing UTR');
    return {
      eventId: delivery,
      kind,
      providerOrderId: b.id,
      providerPaymentId: b.id,
      amountPaise: b.amount_paise,
      currency: b.currency ?? 'INR',
      utr: b.utr ?? null,
    };
  }

  async refund(): Promise<{ refundId: string; status: 'pending' }> {
    // No API refunds: the operator refunds by UPI manually and marks it processed.
    return { refundId: `manual_${randomUUID()}`, status: 'pending' };
  }
}
