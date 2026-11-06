import type { GstStateCode, PaymentMethod } from '@agentbazaar/contracts';

/*
 * The checkout and payment saga's contract, shared by the API (which starts and wakes it), the
 * Temporal workflow and the worker. The workflow bundle includes this file, so it holds only types
 * and constants: no runtime imports.
 */

export const WORKFLOW_ENGINE = Symbol('WORKFLOW_ENGINE');
export const SAGA = { workflow: 'checkoutSaga', wake: 'payment', placed: 'placed' } as const;
export const sagaId = (sessionId: string): string => `checkout-${sessionId}`;

/** The buyer as the saga sees them: vault tokens only, so no personal data reaches workflow history. */
export interface Buyer {
  customerToken: string;
  addressToken: string;
  stateCode: GstStateCode;
  paymentMethod: PaymentMethod;
}

export interface CheckoutSagaInput {
  sessionId: string;
  buyer: Buyer;
  /** SHA-256 of the order's one-time access token; the API keeps the token itself. */
  accessTokenHash: string;
}

export interface PlacedCheckout {
  orderId: string;
  method: PaymentMethod;
}

/** What the database says about an order waiting for its money. */
export type PaymentState =
  { state: 'settled' } | { state: 'closed' } | { state: 'awaiting'; expiresAt: number };

/** The saga's steps. Each is idempotent: a retry or a replay never charges, commits or invoices twice. */
export interface CheckoutActivities {
  reserveStock(sessionId: string): Promise<void>;
  createOrder(input: CheckoutSagaInput): Promise<PlacedCheckout>;
  createPayment(orderId: string): Promise<void>;
  paymentState(orderId: string): Promise<PaymentState>;
  /** 'committed' once the order is paid; otherwise the money has to go back. */
  commitStock(orderId: string): Promise<'committed' | 'closed' | 'sold_out'>;
  issueInvoice(orderId: string): Promise<void>;
  notify(orderId: string): Promise<void>;
  /** Compensation: closes an unpaid order and releases its stock. Returns the order id when it is closed. */
  abandon(sessionId: string, reason: 'expired' | 'cancelled'): Promise<string | null>;
  /** Compensation: refunds a closed order's captured payment, once. */
  refund(orderId: string, reason: string): Promise<void>;
}

/**
 * Where checkout and payment run (WORKFLOW_ENGINE). `inprocess` binds no engine: the API places
 * orders in its own transaction and settles payments in its outbox consumer, as it always has.
 * `temporal` runs the saga above on a Temporal worker.
 */
export interface WorkflowEngine {
  /** Starts the saga for a confirmed checkout; resolves once its order (and online payment) exist. */
  startCheckout(input: CheckoutSagaInput): Promise<PlacedCheckout>;
  /** Tells the checkout's saga that its payment changed. False when no saga is running for it. */
  wake(sessionId: string): Promise<boolean>;
  close(): Promise<void>;
}
