import { Inject, Injectable } from '@nestjs/common';
import type { CompleteCheckoutInput, OrderStatus, OrderView, PaymentMethod } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { one, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import { addSeconds, type Clock } from '../../../shared/kernel/clock.js';
import { CLOCK, LOGGER, METRICS } from '../../../shared/kernel/tokens.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import { appendEvent } from '../../../shared/outbox/outbox.js';
import { CustomizationService } from '../../customization/index.js';
import { PaymentsService } from '../../payments/index.js';
import { PiiService } from '../../pii/index.js';
import { TaxService } from '../../tax/index.js';
import type { Buyer } from './checkout-saga.js';
import type { LockedLine } from './locked-line.js';
import { OrdersService } from './orders.service.js';

/** How long stock stays held and payment is awaited for an online order. */
export const PAYMENT_WINDOW_S = 1800;

export interface PlacedOrder {
  id: string;
  number: string;
  totalPaise: number;
  method: PaymentMethod;
}

/** Turns a confirmed checkout into an order. Personal data goes to the PII vault; the order keeps only tokens. */
@Injectable()
export class OrderPlacement {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(PiiService) private readonly pii: PiiService,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(CustomizationService) private readonly customization: CustomizationService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  /** The buyer's personal data goes to the PII vault; the order (and the checkout saga) keep only tokens. */
  async vaultBuyer(tx: Executor, input: CompleteCheckoutInput): Promise<Buyer> {
    const { address } = input;
    const customerToken = await this.pii.upsertCustomer(tx, {
      email: input.email,
      name: address.name,
      phone: address.phone,
    });
    const addressToken = await this.pii.storeAddress(tx, customerToken, address);
    await this.pii.recordConsent(tx, customerToken, 'order_fulfilment', true, 'checkout');
    return { customerToken, addressToken, stateCode: address.stateCode, paymentMethod: input.paymentMethod };
  }

  /** Runs inside the checkout transaction. Prices are the ones locked on the session. */
  async place(
    tx: Executor,
    session: { id: string; subject: string; lines: LockedLine[] },
    buyer: Buyer,
    accessTokenHash: string,
  ): Promise<PlacedOrder> {
    const { customerToken, addressToken, paymentMethod } = buyer;
    const lines = session.lines;
    const taxes = await this.tax.computeLines(
      lines.map((l) => ({ hsnCode: l.hsnCode, totalPaise: l.totalPaise })),
      buyer.stateCode,
      tx,
    );
    const seq = await one<{ n: number }>(tx, sql`SELECT nextval('order_number_seq')::int AS n`);
    const number = `AB-${seq!.n}`;
    const now = this.clock.now();
    const cod = paymentMethod === 'cod';
    const status: OrderStatus = cod ? 'cod_confirmed' : 'pending_payment';
    const total = lines.reduce((s, l) => s + l.totalPaise, 0);
    const tax = taxes.reduce((s, t) => s + t.taxPaise, 0);
    const o = await one<{ id: string }>(
      tx,
      sql`INSERT INTO orders (number, status, payment_method, subject, customer_token, address_token, place_of_supply, subtotal_paise,
            tax_paise, total_paise, checkout_session_id, access_token_hash, payment_expires_at, updated_at)
          VALUES (${number}, ${status}, ${paymentMethod}, ${session.subject}, ${customerToken}, ${addressToken}, ${buyer.stateCode},
            ${total - tax}, ${tax}, ${total}, ${session.id}, ${accessTokenHash}, ${cod ? null : addSeconds(now, PAYMENT_WINDOW_S)}, ${now})
          RETURNING id`,
    );
    const orderId = o!.id;
    for (const [i, l] of lines.entries()) {
      const t = taxes[i]!;
      const line = await one<{ id: string }>(
        tx,
        sql`INSERT INTO order_lines (order_id, variant_id, sku, product_name, hsn_code, quantity, unit_price_paise, total_paise,
              taxable_paise, taxes, non_returnable, return_window_days)
            VALUES (${orderId}, ${l.variantId}, ${l.sku}, ${l.productName}, ${l.hsnCode}, ${l.quantity}, ${l.unitPricePaise}, ${l.totalPaise},
              ${t.taxablePaise}, ${json(t.taxes)}, ${l.nonReturnable}, ${l.returnWindowDays})
            RETURNING id`,
      );
      if (l.customization) {
        await tx.execute(
          sql`INSERT INTO order_line_customizations (order_line_id, "values") VALUES (${line!.id}, ${json(l.customization)})`,
        );
      }
      if (l.flagged.length) await this.customization.flagForReview(tx, l.sku, l.flagged);
    }
    await tx.execute(
      sql`INSERT INTO order_events (order_id, from_status, to_status, actor, note)
          VALUES (${orderId}, NULL, ${status}, ${session.subject}, ${cod ? 'Cash on delivery confirmed' : 'Waiting for payment'})`,
    );
    if (cod) await this.payments.codPayment(tx, orderId, total);
    await appendEvent(tx, 'order.created', orderId, {
      orderId,
      number,
      customerToken,
      paymentMethod,
      totalPaise: total,
    });
    return { id: orderId, number, totalPaise: total, method: paymentMethod };
  }

  /** After commit, never inside the transaction: opens the gateway payment. A gateway failure never loses the order. */
  async confirm(order: PlacedOrder & { accessToken: string }): Promise<OrderView> {
    let paymentUrl: string | null = null;
    if (order.method === 'online') {
      try {
        paymentUrl = (
          await this.payments.createForOrder({
            id: order.id,
            number: order.number,
            totalPaise: order.totalPaise,
          })
        ).paymentUrl;
      } catch (err) {
        this.logger.warn({ err }, 'payment creation failed; the order is kept without a payment link');
      }
    }
    this.metrics.ordersCreated.inc({ method: order.method });
    return { ...(await this.orders.view(order.id)), paymentUrl, accessToken: order.accessToken };
  }

  /** The checkout saga placed the order and opened its payment; the buyer gets the view and the one-time token. */
  async placedBySaga(order: { orderId: string; method: PaymentMethod }, accessToken: string): Promise<OrderView> {
    this.metrics.ordersCreated.inc({ method: order.method });
    return { ...(await this.orders.view(order.orderId)), accessToken };
  }
}
