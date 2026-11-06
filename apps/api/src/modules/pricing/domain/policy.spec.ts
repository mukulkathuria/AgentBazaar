import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canTransition, IllegalTransitionError, transition } from './negotiation-state.js';
import {
  askAt,
  type BandPolicy,
  computeLadder,
  decideOffer,
  guardedFloor,
  type LadderInput,
  PricingMisconfiguredError,
  volumeAlternatives,
} from './policy.js';

const standard: BandPolicy = {
  band: 'standard',
  negotiableBps: 800,
  volumeTiers: [
    { minQty: 3, extraBps: 200 },
    { minQty: 5, extraBps: 400 },
    { minQty: 10, extraBps: 700 },
  ],
  maxRounds: 4,
  approvalThresholdPaise: null,
  quoteTtlSeconds: 900,
  concessionExponent: 2,
};

// The demo keyboard: list ₹5,499 with a floor of ₹4,869.92 computed from landed cost and margin.
const keyboard: LadderInput = { listUnitPaise: 549_900, floorUnitPaise: 486_992, quantity: 1, customized: false };

describe('@lite pricing policy engine', () => {
  it('builds the expected ladder for the demo keyboard', () => {
    const l = computeLadder(standard, keyboard);
    expect(l).toEqual({ openingUnit: 549_900, minUnit: 506_000, maxRounds: 4, exponent: 2 });
    expect([0, 1, 2, 3, 4].map((r) => askAt(l, r))).toEqual([549_900, 547_200, 539_000, 525_300, 506_000]);
  });

  it('plays the demo negotiation deterministically', () => {
    const l = computeLadder(standard, keyboard);
    let pos = { round: 0, currentAskUnit: l.openingUnit, quantity: 1 };
    const steps = [440_000, 480_000, 490_000, 510_000].map((offer) => {
      const d = decideOffer(standard, l, pos, offer);
      pos = { ...pos, round: d.round, currentAskUnit: d.unitPaise };
      return [d.kind, d.unitPaise];
    });
    expect(steps).toEqual([
      ['counter', 547_200],
      ['counter', 539_000],
      ['counter', 525_300],
      ['accept', 510_000],
    ]);
  });

  it('offers volume trades below the current ask', () => {
    const alts = volumeAlternatives(standard, keyboard, 1, 547_200);
    expect(alts[0]).toEqual({ quantity: 3, unitPricePaise: 536_400, reason: 'volume' });
    expect(alts.every((a) => a.unitPricePaise < 547_200)).toBe(true);
  });

  it('never negotiates customized items, only applies quantity discounts', () => {
    const l = computeLadder(standard, { ...keyboard, customized: true });
    expect(l.maxRounds).toBe(0);
    expect(decideOffer(standard, l, { round: 0, currentAskUnit: l.openingUnit, quantity: 1 }, 500_000).kind).toBe('reject');
    expect(computeLadder(standard, { ...keyboard, customized: true, quantity: 5 }).openingUnit).toBeLessThan(549_900);
  });

  it('rejects a floor above list as a misconfiguration', () => {
    expect(() => computeLadder(standard, { ...keyboard, floorUnitPaise: 600_000 })).toThrow(PricingMisconfiguredError);
  });

  it('sends large discounts on premium items to a human', () => {
    const premium: BandPolicy = { ...standard, band: 'premium', negotiableBps: 300, maxRounds: 3, approvalThresholdPaise: 100_000 };
    const gpu: LadderInput = { listUnitPaise: 5_499_900, floorUnitPaise: 4_600_000, quantity: 2, customized: false };
    const l = computeLadder(premium, gpu);
    const d = decideOffer(premium, l, { round: 3, currentAskUnit: l.minUnit, quantity: 2 }, l.minUnit);
    expect(d.kind).toBe('approval');
  });

  it('rejects junk offers instead of misbehaving', () => {
    const l = computeLadder(standard, keyboard);
    const pos = { round: 0, currentAskUnit: l.openingUnit, quantity: 1 };
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decideOffer(standard, l, pos, bad)).toThrow(RangeError);
    }
  });

  const policyArb = fc.record({
    band: fc.constantFrom('fixed' as const, 'standard' as const, 'premium' as const),
    negotiableBps: fc.integer({ min: 0, max: 5000 }),
    volumeTiers: fc.array(fc.record({ minQty: fc.integer({ min: 2, max: 200 }), extraBps: fc.integer({ min: 0, max: 5000 }) }), {
      maxLength: 5,
    }),
    maxRounds: fc.integer({ min: 0, max: 10 }),
    approvalThresholdPaise: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null }),
    quoteTtlSeconds: fc.constant(900),
    concessionExponent: fc.double({ min: 0.2, max: 5, noNaN: true }),
  });
  const inputArb = fc
    .record({ list: fc.integer({ min: 100, max: 1_000_000_000 }), floorRatio: fc.double({ min: 0, max: 1, noNaN: true }) })
    .chain(({ list, floorRatio }) =>
      fc.record({
        listUnitPaise: fc.constant(list),
        floorUnitPaise: fc.constant(Math.floor(list * floorRatio)),
        quantity: fc.integer({ min: 1, max: 1000 }),
        customized: fc.boolean(),
      }),
    );

  it('PROPERTY: ladder stays within [floor-guard, list] and asks never rise', () => {
    fc.assert(
      fc.property(policyArb, inputArb, (policy, input) => {
        const l = computeLadder(policy, input);
        expect(l.openingUnit).toBeLessThanOrEqual(input.listUnitPaise);
        expect(l.minUnit).toBeLessThanOrEqual(l.openingUnit);
        expect(l.minUnit).toBeGreaterThanOrEqual(input.floorUnitPaise);
        if (l.minUnit < input.listUnitPaise) expect(l.minUnit).toBeGreaterThanOrEqual(guardedFloor(input.floorUnitPaise));
        let prev = Number.POSITIVE_INFINITY;
        for (let r = 0; r <= l.maxRounds + 1; r++) {
          const a = askAt(l, r);
          expect(a).toBeLessThanOrEqual(prev);
          expect(a).toBeGreaterThanOrEqual(l.minUnit);
          prev = a;
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('PROPERTY: no sequence of offers ever prices at or below the floor', () => {
    fc.assert(
      fc.property(
        policyArb,
        inputArb,
        fc.array(fc.integer({ min: 1, max: 2_000_000_000 }), { minLength: 1, maxLength: 15 }),
        (policy, input, offers) => {
          const l = computeLadder(policy, input);
          let pos = { round: 0, currentAskUnit: l.openingUnit, quantity: input.quantity };
          let counters = 0;
          for (const offer of offers) {
            const d = decideOffer(policy, l, pos, offer);
            expect(d.unitPaise).toBeLessThanOrEqual(pos.currentAskUnit);
            expect(d.unitPaise).toBeLessThanOrEqual(input.listUnitPaise);
            expect(d.unitPaise).toBeGreaterThanOrEqual(input.floorUnitPaise);
            if (d.unitPaise < input.listUnitPaise) expect(d.unitPaise).toBeGreaterThan(input.floorUnitPaise);
            expect(d.round).toBeLessThanOrEqual(l.maxRounds);
            if (d.kind === 'counter') counters++;
            if (d.kind !== 'counter') break;
            pos = { ...pos, round: d.round, currentAskUnit: d.unitPaise };
          }
          expect(counters).toBeLessThanOrEqual(l.maxRounds);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('PROPERTY: buying more never costs more per unit at opening', () => {
    fc.assert(
      fc.property(policyArb, inputArb, fc.integer({ min: 1, max: 999 }), (policy, input, extra) => {
        const small = computeLadder(policy, input);
        const big = computeLadder(policy, { ...input, quantity: Math.min(1000, input.quantity + extra) });
        expect(big.openingUnit).toBeLessThanOrEqual(small.openingUnit);
      }),
      { numRuns: 1000 },
    );
  });

  it('enforces the negotiation state machine', () => {
    expect(transition('quote', 'counter')).toBe('counter');
    expect(canTransition('rejected', 'checkout')).toBe(true);
    expect(() => transition('checkout', 'quote')).toThrow(IllegalTransitionError);
    expect(() => transition('expired', 'accepted')).toThrow(IllegalTransitionError);
    expect(() => transition('pending_approval', 'checkout')).toThrow(IllegalTransitionError);
  });
});
