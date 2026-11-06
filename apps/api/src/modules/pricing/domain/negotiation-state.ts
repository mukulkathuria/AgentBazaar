import type { NegotiationState } from '@agentbazaar/contracts';

/** Legal transitions. "rejected" means no more counters; the seller's last quote may still be accepted. */
const TRANSITIONS: Record<NegotiationState, readonly NegotiationState[]> = {
  inquiry: ['quote', 'expired'],
  quote: ['counter', 'accepted', 'rejected', 'pending_approval', 'expired', 'checkout'],
  counter: ['counter', 'accepted', 'rejected', 'pending_approval', 'expired', 'checkout'],
  pending_approval: ['accepted', 'rejected', 'expired'],
  accepted: ['checkout', 'expired'],
  rejected: ['checkout', 'expired'],
  expired: [],
  checkout: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: NegotiationState,
    readonly to: NegotiationState,
  ) {
    super(`Negotiation cannot move from ${from} to ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: NegotiationState, to: NegotiationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: NegotiationState, to: NegotiationState): NegotiationState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export const isTerminal = (s: NegotiationState): boolean => TRANSITIONS[s].length === 0;
export const acceptsOffers = (s: NegotiationState): boolean => s === 'quote' || s === 'counter';
export const quoteAcceptable = (s: NegotiationState): boolean =>
  s === 'quote' || s === 'counter' || s === 'accepted' || s === 'rejected';
