import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import { MockGatewayAction, type PaymentStatus, type PaymentView, Routes } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KeyRing } from '../../shared/crypto/keyring.js';
import { hmacSha256, randomToken, safeEqual, sha256Hex } from '../../shared/crypto/primitives.js';
import { inTransaction, one, type Executor } from '../../shared/db/database.js';
import { json } from '../../shared/db/sql-helpers.js';
import { Auth } from '../../shared/http/auth.js';
import { ZodPipe } from '../../shared/http/zod.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { AppError, notFound } from '../../shared/kernel/errors.js';
import { CLOCK, CONFIG, DB, KEYS } from '../../shared/kernel/tokens.js';
import { appendEvent } from '../../shared/outbox/outbox.js';
import { InvalidSignatureError, nextPaymentStatus, type PaymentPort } from './domain/payment-port.js';
import { MockPaymentAdapter, RazorpayAdapter, YoupiPgAdapter } from './infrastructure/adapters.js';

export const PAYMENT_PORT = Symbol('PAYMENT_PORT');

interface PaymentRow {
  id: string;
  order_id: string;
  provider: 'mock' | 'razorpay' | 'youpi-pg' | 'cod';
  status: PaymentStatus;
  amount_paise: number;
  currency: 'INR';
  provider_order_id: string | null;
  provider_payment_id: string | null;
  payment_url: string | null;
  client_params: Record<string, string>;
  access_token_hash: string;
}

export type WebhookResult = 'applied' | 'duplicate' | 'ignored' | 'stale' | 'amount_mismatch';

const view = (p: PaymentRow): PaymentView => ({
  paymentId: p.id,
  orderId: p.order_id,
  provider: p.provider,
  status: p.status,
  amountPaise: p.amount_paise,
  currency: p.currency,
  paymentUrl: p.payment_url,
  providerRef: p.provider_order_id,
  clientParams: p.client_params,
});

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_PORT) readonly port: PaymentPort,
  ) {}

  /**
   * Creates the gateway payment after the order commits (never inside the order transaction). Once
   * per order: a retried saga step reuses the row, and goes back to the gateway only if that call never completed.
   */
  async createForOrder(order: { id: string; number: string; totalPaise: number }): Promise<PaymentView> {
    const accessToken = randomToken(24);
    const row = await inTransaction(this.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`payment:${order.id}`}))`);
      const existing = await one<PaymentRow>(
        tx,
        sql`SELECT * FROM payments WHERE order_id = ${order.id} AND provider = ${this.port.name} ORDER BY created_at LIMIT 1`,
      );
      return (
        existing ??
        (await one<PaymentRow>(
          tx,
          sql`INSERT INTO payments (order_id, provider, status, amount_paise, access_token_hash)
              VALUES (${order.id}, ${this.port.name}, 'created', ${order.totalPaise}, ${sha256Hex(accessToken)}) RETURNING *`,
        ))!
      );
    });
    if (row.provider_order_id) return view(row);
    const created = await this.port.createPayment({
      paymentId: row.id,
      orderId: order.id,
      orderNumber: order.number,
      amountPaise: order.totalPaise,
      currency: 'INR',
      accessToken,
    });
    const updated = await one<PaymentRow>(
      this.db,
      sql`UPDATE payments SET provider_order_id = ${created.providerOrderId}, payment_url = ${created.paymentUrl},
            client_params = ${json(created.clientParams)}, access_token_hash = ${sha256Hex(accessToken)}, updated_at = now()
          WHERE id = ${row.id} RETURNING *`,
    );
    return view(updated!);
  }

  /** Cash on delivery: the order is placed, money has not arrived. */
  async codPayment(tx: Executor, orderId: string, amountPaise: number): Promise<void> {
    await tx.execute(
      sql`INSERT INTO payments (order_id, provider, status, amount_paise, access_token_hash)
          VALUES (${orderId}, 'cod', 'cod_pending', ${amountPaise}, ${sha256Hex(randomToken(24))})`,
    );
  }

  async markCodCollected(tx: Executor, orderId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE payments SET status = 'cod_collected', updated_at = now() WHERE order_id = ${orderId} AND status = 'cod_pending'`,
    );
  }

  async get(paymentId: string, token: string): Promise<PaymentView> {
    const p = await one<PaymentRow>(this.db, sql`SELECT * FROM payments WHERE id = ${paymentId}`);
    if (!p || !safeEqual(p.access_token_hash, sha256Hex(token))) throw notFound('Payment');
    return view(p);
  }

  /**
   * Verify signature -> dedupe by event id -> check order, amount and currency -> move status
   * forward only. Replayed and out-of-order events change nothing.
   */
  async handleWebhook(provider: string, raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookResult> {
    if (provider !== this.port.name) throw notFound('Webhook endpoint');
    let ev;
    try {
      ev = this.port.parseWebhook(raw, headers, this.clock.now());
    } catch (e) {
      if (e instanceof InvalidSignatureError) throw new AppError('invalid_signature', e.message);
      throw e;
    }
    return inTransaction(this.db, async (tx) => {
      const fresh = await one<{ event_id: string }>(
        tx,
        sql`INSERT INTO webhook_events (provider, event_id, payload)
            VALUES (${provider}, ${ev.eventId}, ${json({ kind: ev.kind, providerOrderId: ev.providerOrderId, amountPaise: ev.amountPaise })})
            ON CONFLICT DO NOTHING RETURNING event_id`,
      );
      if (!fresh) return 'duplicate';
      const outcome = async (o: WebhookResult) => {
        await tx.execute(sql`UPDATE webhook_events SET outcome = ${o} WHERE provider = ${provider} AND event_id = ${ev.eventId}`);
        return o;
      };
      const p = await one<PaymentRow>(
        tx,
        sql`SELECT * FROM payments WHERE provider = ${provider} AND provider_order_id = ${ev.providerOrderId} FOR UPDATE`,
      );
      if (!p) return outcome('ignored');
      if (ev.amountPaise !== p.amount_paise || ev.currency !== p.currency) return outcome('amount_mismatch');
      const next = nextPaymentStatus(p.status, ev.kind);
      if (!next) return outcome('stale');
      await tx.execute(
        sql`UPDATE payments SET status = ${next}, provider_payment_id = COALESCE(${ev.providerPaymentId}, provider_payment_id),
              utr = COALESCE(${ev.utr}, utr), updated_at = now() WHERE id = ${p.id}`,
      );
      await appendEvent(tx, 'payment.status_changed', p.order_id, { paymentId: p.id, orderId: p.order_id, status: next });
      return outcome('applied');
    });
  }

  /** Refunds the captured payment of an order, once. */
  async refund(orderId: string, reason: string): Promise<'processed' | 'pending' | 'none'> {
    const p = await one<PaymentRow>(
      this.db,
      sql`SELECT * FROM payments WHERE order_id = ${orderId} AND status IN ('captured','reconciled','cod_collected')
          ORDER BY created_at DESC LIMIT 1`,
    );
    if (!p) return 'none';
    const claimed = await one<{ id: string }>(
      this.db,
      sql`INSERT INTO refunds (payment_id, amount_paise, status, reason) VALUES (${p.id}, ${p.amount_paise}, 'pending', ${reason})
          ON CONFLICT DO NOTHING RETURNING id`,
    );
    if (!claimed) return 'pending';
    const r =
      p.provider === 'cod'
        ? { refundId: `manual_${claimed.id}`, status: 'pending' as const }
        : await this.port.refund(p.provider_payment_id ?? p.provider_order_id ?? p.id, p.amount_paise);
    await inTransaction(this.db, async (tx) => {
      await tx.execute(
        sql`UPDATE refunds SET status = ${r.status === 'processed' ? 'processed' : 'pending'}, provider_refund_id = ${r.refundId},
              updated_at = now() WHERE id = ${claimed.id}`,
      );
      const status: PaymentStatus = r.status === 'processed' ? 'refunded' : 'refund_pending';
      await tx.execute(sql`UPDATE payments SET status = ${status}, updated_at = now() WHERE id = ${p.id}`);
      await appendEvent(tx, 'payment.refund_updated', orderId, { orderId, paymentId: p.id, status });
    });
    return r.status;
  }

  /** Mock gateway only: behaves exactly like the gateway calling our webhook. */
  async mockComplete(paymentId: string, outcome: 'success' | 'failure'): Promise<WebhookResult> {
    if (!(this.port instanceof MockPaymentAdapter)) throw notFound('Mock gateway');
    const p = await one<PaymentRow>(this.db, sql`SELECT * FROM payments WHERE id = ${paymentId}`);
    if (!p?.provider_order_id) throw notFound('Payment');
    const ev = this.port.signedEvent({
      kind: outcome === 'success' ? 'captured' : 'failed',
      providerOrderId: p.provider_order_id,
      amountPaise: p.amount_paise,
    });
    return this.handleWebhook('mock', ev.raw, ev.headers);
  }
}

@Controller()
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post('api/v1/payments/webhooks/:provider')
  @Auth('public')
  async webhook(@Param('provider') provider: string, @Req() req: FastifyRequest & { rawBody?: Buffer }, @Res() reply: FastifyReply) {
    if (!req.rawBody) throw new AppError('validation_failed', 'Webhook body required');
    const result = await this.payments.handleWebhook(provider, req.rawBody, req.headers);
    await reply.status(result === 'amount_mismatch' ? 409 : 200).send({ received: true, result });
  }

  @Get('api/v1/payments/:id')
  @Auth('optional')
  get(@Param(new ZodPipe(Routes.getPayment.params)) p: { id: string }, @Query(new ZodPipe(Routes.getPayment.query)) q: { t: string }) {
    return this.payments.get(p.id, q.t);
  }

  @Post('api/v1/mock-gateway/payments/:id/complete')
  @HttpCode(200)
  @Auth('public')
  async mock(
    @Param(new ZodPipe(Routes.mockGatewayComplete.params)) p: { id: string },
    @Body(new ZodPipe(MockGatewayAction)) body: { outcome: 'success' | 'failure' },
  ) {
    await this.payments.mockComplete(p.id, body.outcome);
    return { ok: true as const };
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_PORT,
      inject: [CONFIG, KEYS],
      useFactory: (config: AppConfig, keys: KeyRing): PaymentPort => {
        const env = config.env;
        if (config.adapters.payment === 'razorpay') {
          return new RazorpayAdapter(env.RAZORPAY_KEY_ID!, env.RAZORPAY_KEY_SECRET!, env.RAZORPAY_WEBHOOK_SECRET!);
        }
        if (config.adapters.payment === 'youpi-pg') return new YoupiPgAdapter(env.YOUPI_BASE_URL!, env.YOUPI_API_KEY, env.YOUPI_WEBHOOK_SECRET!);
        const secret = env.MOCK_WEBHOOK_SECRET ?? hmacSha256(keys.quoteKey, 'mock-webhook-secret').toString('hex');
        return new MockPaymentAdapter(secret, env.PUBLIC_WEB_URL);
      },
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
