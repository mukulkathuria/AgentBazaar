import { OrderStatus } from '@agentbazaar/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canTransition, IllegalOrderTransitionError, isTerminal, stockCommitted, transition } from './order-state.js';

const ALL = OrderStatus.options;
const GOODS_MOVED = new Set<OrderStatus>([
  'shipped',
  'delivered',
  'return_requested',
  'returned',
  'refunded',
]);
const start = fc.constantFrom<OrderStatus>('pending_payment', 'cod_confirmed');
const events = fc.array(fc.constantFrom(...ALL), { maxLength: 40 });

/** Applies each event if legal; an illegal one must throw and leave the order unchanged. */
function run(initial: OrderStatus, evs: OrderStatus[]): OrderStatus[] {
  const history = [initial];
  let s = initial;
  for (const e of evs) {
    if (canTransition(s, e)) {
      s = transition(s, e);
      history.push(s);
    } else {
      expect(() => transition(s, e)).toThrow(IllegalOrderTransitionError);
    }
  }
  return history;
}

describe('@lite order state machine', () => {
  it('never moves goods before money (paid) or a COD promise', () => {
    fc.assert(
      fc.property(start, events, (s0, evs) => {
        const h = run(s0, evs);
        h.forEach((s, i) => {
          if (GOODS_MOVED.has(s))
            expect(h.slice(0, i).some((p) => p === 'paid' || p === 'cod_confirmed')).toBe(true);
          // Shipping comes straight from a settled state: an observed-only UPI payment never ships.
          if (s === 'shipped') expect(['paid', 'cod_confirmed']).toContain(h[i - 1]);
          if (s === 'refunded') expect(h[i - 1]).toBe('returned');
        });
      }),
    );
  });

  it('terminal states absorb every later event', () => {
    fc.assert(
      fc.property(start, events, events, (s0, before, after) => {
        const h = run(s0, before);
        const last = h[h.length - 1]!;
        if (!isTerminal(last)) return;
        expect(run(last, after)).toEqual([last]);
      }),
    );
  });

  it('every status is reachable from a creation status and terminal ones are exactly cancelled, expired, refunded', () => {
    const seen = new Set<OrderStatus>(['pending_payment', 'cod_confirmed']);
    for (let grew = true; grew;) {
      grew = false;
      for (const from of [...seen]) {
        for (const to of ALL) {
          if (canTransition(from, to) && !seen.has(to)) {
            seen.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...ALL].sort());
    expect(ALL.filter(isTerminal).sort()).toEqual(['cancelled', 'expired', 'refunded']);
  });

  it('names both states in the error', () => {
    expect(() => transition('shipped', 'cancelled')).toThrow(
      'An order that is shipped cannot become cancelled',
    );
  });

  it('allows exactly the legal moves between every pair of statuses', () => {
    // Written out in full so any change to the state machine is a deliberate one.
    const LEGAL: Record<OrderStatus, OrderStatus[]> = {
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
    for (const from of ALL) {
      for (const to of ALL) {
        expect({ from, to, legal: canTransition(from, to) }).toEqual({ from, to, legal: LEGAL[from].includes(to) });
      }
      for (const to of LEGAL[from]) expect(transition(from, to)).toBe(to);
    }
  });

  it('raises a typed error that carries both statuses, with every underscore spelled out', () => {
    let caught: unknown;
    try {
      transition('payment_observed', 'return_requested');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IllegalOrderTransitionError);
    expect(caught).toMatchObject({ name: 'IllegalOrderTransitionError', from: 'payment_observed', to: 'return_requested' });
    expect((caught as Error).message).toBe('An order that is payment observed cannot become return requested');
  });

  it('commits stock only once the order is paid or COD is confirmed', () => {
    expect(ALL.filter(stockCommitted).sort()).toEqual(['cod_confirmed', 'paid']);
  });
});
