import { NegotiationState } from '@agentbazaar/contracts';
import { describe, expect, it } from 'vitest';
import {
  acceptsOffers,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  quoteAcceptable,
  transition,
} from './negotiation-state.js';

const ALL = NegotiationState.options;

/** The full legal-move table, written out so any change to the state machine is a deliberate one. */
const LEGAL: Record<NegotiationState, NegotiationState[]> = {
  inquiry: ['quote', 'expired'],
  quote: ['counter', 'accepted', 'rejected', 'pending_approval', 'expired', 'checkout'],
  counter: ['counter', 'accepted', 'rejected', 'pending_approval', 'expired', 'checkout'],
  pending_approval: ['accepted', 'rejected', 'expired'],
  accepted: ['checkout', 'expired'],
  rejected: ['checkout', 'expired'],
  expired: [],
  checkout: [],
};

describe('@lite negotiation state machine', () => {
  it('allows exactly the legal moves between every pair of states', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect({ from, to, legal: canTransition(from, to) }).toEqual({ from, to, legal: LEGAL[from].includes(to) });
      }
    }
  });

  it('returns the target of a legal move and throws a typed error naming both states otherwise', () => {
    for (const from of ALL) {
      for (const to of LEGAL[from]) expect(transition(from, to)).toBe(to);
    }
    let caught: unknown;
    try {
      transition('checkout', 'quote');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IllegalTransitionError);
    const err = caught as IllegalTransitionError;
    expect(err).toMatchObject({ name: 'IllegalTransitionError', from: 'checkout', to: 'quote' });
    expect(err.message).toBe('Negotiation cannot move from checkout to quote');
  });

  it('treats only expired and checkout as terminal', () => {
    expect(ALL.filter(isTerminal).sort()).toEqual(['checkout', 'expired']);
  });

  it('takes offers only while a quote or counter is open', () => {
    expect(ALL.filter(acceptsOffers).sort()).toEqual(['counter', 'quote']);
  });

  it("lets the buyer accept the seller's last quote even after the seller stops countering", () => {
    expect(ALL.filter(quoteAcceptable).sort()).toEqual(['accepted', 'counter', 'quote', 'rejected']);
  });
});
