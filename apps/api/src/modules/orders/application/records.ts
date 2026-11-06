import type {
  CustomizationValues,
  GstStateCode,
  OrderStatus,
  OrderView,
  PaymentMethod,
} from '@agentbazaar/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { one, rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { appendEvent } from '../../../shared/outbox/outbox.js';
import type { TaxLine } from '../../tax/index.js';
import { IllegalOrderTransitionError, transition } from '../domain/order-state.js';
import { isUuid } from './locked-line.js';

export interface OrderRow {
  id: string;
  number: string;
  status: OrderStatus;
  payment_method: PaymentMethod;
  subject: string;
  customer_token: string;
  address_token: string;
  place_of_supply: GstStateCode;
  subtotal_paise: number;
  tax_paise: number;
  total_paise: number;
  access_token_hash: string;
  checkout_session_id: string | null;
  invoice_number: string | null;
  tracking_number: string | null;
  payment_expires_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface OrderLineRow {
  id: string;
  order_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  hsn_code: string;
  quantity: number;
  unit_price_paise: number;
  total_paise: number;
  taxable_paise: number;
  taxes: TaxLine[];
  non_returnable: boolean;
  return_window_days: number;
  customization: CustomizationValues | null;
}

interface EventRow {
  order_id: string;
  to_status: OrderStatus;
  note: string | null;
  created_at: Date;
}

/** Owner of an order's stock reservations in the inventory module. */
export const ownerRef = (orderId: string): string => `order:${orderId}`;

export async function lockOrder(tx: Executor, orderId: string): Promise<OrderRow | undefined> {
  return isUuid(orderId)
    ? one<OrderRow>(tx, sql`SELECT * FROM orders WHERE id = ${orderId} FOR UPDATE`)
    : undefined;
}

export async function linesOf(ex: Executor, orderIds: readonly string[]): Promise<OrderLineRow[]> {
  if (!orderIds.length) return [];
  return rows<OrderLineRow>(
    ex,
    sql`SELECT l.*, c."values" AS customization FROM order_lines l
        LEFT JOIN order_line_customizations c ON c.order_line_id = l.id
        WHERE l.order_id = ANY(${pgArray(orderIds, 'uuid')}) ORDER BY l.sku, l.id`,
  );
}

export interface Move {
  actor: string;
  at: Date;
  note?: string;
  /** Extra column assignments, e.g. sql`tracking_number = ${t}`. */
  set?: SQL;
  payload?: Record<string, unknown>;
}

/**
 * The only way an order changes status: checks the transition table, then appends to the
 * append-only order_events log and the outbox in the caller's transaction. Updates `o` in place.
 */
export async function moveOrder(tx: Executor, o: OrderRow, to: OrderStatus, m: Move): Promise<void> {
  try {
    transition(o.status, to);
  } catch (e) {
    if (e instanceof IllegalOrderTransitionError) throw new AppError('illegal_transition', e.message);
    throw e;
  }
  await tx.execute(
    sql`UPDATE orders SET status = ${to}, updated_at = ${m.at}, version = version + 1${m.set ? sql`, ${m.set}` : sql``} WHERE id = ${o.id}`,
  );
  await tx.execute(
    sql`INSERT INTO order_events (order_id, from_status, to_status, actor, note) VALUES (${o.id}, ${o.status}, ${to}, ${m.actor}, ${m.note ?? null})`,
  );
  await appendEvent(tx, `order.${to}`, o.id, {
    orderId: o.id,
    number: o.number,
    customerToken: o.customer_token,
    from: o.status,
    to,
    ...m.payload,
  });
  o.status = to;
}

/** Orders as the API shows them. The payment link is only useful while payment is still due. */
export async function orderViews(ex: Executor, where: SQL, page = sql``): Promise<OrderView[]> {
  const os = await rows<OrderRow & { payment_url: string | null }>(
    ex,
    sql`SELECT o.*, (SELECT p.payment_url FROM payments p WHERE p.order_id = o.id AND p.provider <> 'cod'
                     ORDER BY p.created_at DESC LIMIT 1) AS payment_url
        FROM orders o WHERE ${where} ORDER BY o.created_at DESC, o.id ${page}`,
  );
  if (!os.length) return [];
  const ids = os.map((o) => o.id);
  const lines = await linesOf(ex, ids);
  // No event predates its order (a day of slack for clock steps), so partitions older than the oldest order are skipped.
  const events = await rows<EventRow>(
    ex,
    sql`SELECT order_id, to_status, note, created_at FROM order_events WHERE order_id = ANY(${pgArray(ids, 'uuid')})
          AND created_at >= (SELECT min(created_at) - interval '1 day' FROM orders WHERE id = ANY(${pgArray(ids, 'uuid')}))
        ORDER BY id`,
  );
  return os.map((o) => ({
    orderId: o.id,
    number: o.number,
    status: o.status,
    paymentMethod: o.payment_method,
    lines: lines
      .filter((l) => l.order_id === o.id)
      .map((l) => ({
        sku: l.sku,
        productName: l.product_name,
        quantity: l.quantity,
        unitPricePaise: l.unit_price_paise,
        totalPaise: l.total_paise,
        taxablePaise: l.taxable_paise,
        taxes: l.taxes,
        customization: l.customization,
        nonReturnable: l.non_returnable,
      })),
    subtotalPaise: o.subtotal_paise,
    taxPaise: o.tax_paise,
    totalPaise: o.total_paise,
    currency: 'INR',
    placeOfSupply: o.place_of_supply,
    invoiceNumber: o.invoice_number,
    trackingNumber: o.tracking_number,
    paymentUrl: o.status === 'pending_payment' || o.status === 'payment_failed' ? o.payment_url : null,
    createdAt: o.created_at.toISOString(),
    timeline: events
      .filter((e) => e.order_id === o.id)
      .map((e) => ({ status: e.to_status, at: e.created_at.toISOString(), note: e.note })),
  }));
}
