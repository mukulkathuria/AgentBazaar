import type { OrderStatus } from '@agentbazaar/contracts';

/**
 * Legal order transitions. Goods move only after money (paid) or a COD promise (cod_confirmed);
 * UPI orders wait in payment_observed until reconciled. Empty lists are terminal.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['payment_observed', 'paid', 'payment_failed', 'expired', 'cancelled'],
  payment_failed: ['paid', 'payment_observed', 'expired', 'cancelled'],
  payment_observed: ['paid', 'payment_failed', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  cod_confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['return_requested'],
  return_requested: ['returned', 'delivered'],
  returned: ['refunded'],
  refunded: [],
  cancelled: [],
  expired: [],
};

export class IllegalOrderTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`An order that is ${from.replace(/_/g, ' ')} cannot become ${to.replace(/_/g, ' ')}`);
    this.name = 'IllegalOrderTransitionError';
  }
}

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => TRANSITIONS[from].includes(to);

export function transition(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransition(from, to)) throw new IllegalOrderTransitionError(from, to);
  return to;
}

export const isTerminal = (s: OrderStatus): boolean => TRANSITIONS[s].length === 0;

/** Stock has left the shelf (committed) in these states; earlier states only hold a reservation. */
export const stockCommitted = (s: OrderStatus): boolean => s === 'paid' || s === 'cod_confirmed';
