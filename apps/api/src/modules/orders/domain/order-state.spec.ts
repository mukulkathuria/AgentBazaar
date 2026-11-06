import { OrderStatus } from '@agentbazaar/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canTransition, IllegalOrderTransitionError, isTerminal, transition } from './order-state.js';

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
});
