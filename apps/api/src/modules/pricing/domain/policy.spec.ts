import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canTransition, IllegalTransitionError, transition } from './negotiation-state.js';
import {
  askAt,
  type BandPolicy,
  computeLadder,
  decideOffer,
  guardedFloor,
  type Ladder,
  type LadderInput,
  PricingMisconfiguredError,
  volumeAlternatives,
  volumeBps,
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

describe('@lite pricing policy engine: exact decisions at every boundary', () => {
  // Linear concession over three rounds from ₹1,000 down to ₹900: asks 100,000 / 96,700 / 93,400 / 90,000 paise.
  const linear: BandPolicy = { ...standard, negotiableBps: 1000, volumeTiers: [], maxRounds: 3, concessionExponent: 1 };
  const item: LadderInput = { listUnitPaise: 100_000, floorUnitPaise: 50_000, quantity: 1, customized: false };
  // A literal, not computeLadder(): policy code run outside a test counts as static for Stryker.
  const ladder: Ladder = { openingUnit: 100_000, minUnit: 90_000, maxRounds: 3, exponent: 1 };
  const at = (round: number, currentAskUnit: number, quantity = 1) => ({ round, currentAskUnit, quantity });

  it('guards the floor by the larger of ₹1 and 0.5%, rounded up to a whole rupee', () => {
    expect(guardedFloor(0)).toBe(100);
    expect(guardedFloor(19_999)).toBe(20_100);
    expect(guardedFloor(20_001)).toBe(20_200);
    expect(guardedFloor(486_992)).toBe(489_500);
  });

  it('applies the largest quantity discount reached, from the tier minimum up', () => {
    const tiers = [
      { minQty: 3, extraBps: 500 },
      { minQty: 5, extraBps: 100 },
    ];
    expect([1, 2, 3, 4, 5, 50].map((q) => volumeBps(tiers, q))).toEqual([0, 0, 500, 500, 500, 500]);
    expect(volumeBps(standard.volumeTiers, 4)).toBe(200);
    expect(volumeBps(standard.volumeTiers, 5)).toBe(400);
    expect(volumeBps([], 99)).toBe(0);
  });

  it('builds the ladder from list, negotiable share and floor guard', () => {
    expect(computeLadder(linear, item)).toEqual(ladder);
    expect([0, 1, 2, 3, 4, -1].map((r) => askAt(ladder, r))).toEqual([100_000, 96_700, 93_400, 90_000, 90_000, 100_000]);
    // A volume discount lowers the opening, but never below the guarded floor.
    const volume: BandPolicy = { ...linear, volumeTiers: [{ minQty: 3, extraBps: 1000 }] };
    expect(computeLadder(volume, { ...item, quantity: 3 })).toEqual({ openingUnit: 90_000, minUnit: 81_000, maxRounds: 3, exponent: 1 });
    expect(computeLadder(volume, { ...item, floorUnitPaise: 95_000, quantity: 3 })).toEqual({
      openingUnit: 95_500,
      minUnit: 95_500,
      maxRounds: 0,
      exponent: 1,
    });
    // The guard caps the concession too, and a floor whose guard reaches list leaves nothing to negotiate.
    expect(computeLadder(linear, { ...item, floorUnitPaise: 95_000 }).minUnit).toBe(95_500);
    expect(computeLadder(linear, { ...item, listUnitPaise: 10_100, floorUnitPaise: 10_000 })).toEqual({
      openingUnit: 10_100,
      minUnit: 10_100,
      maxRounds: 0,
      exponent: 1,
    });
  });

  it('refuses impossible inputs with clear errors', () => {
    for (const listUnitPaise of [0, -100, 100.5, Number.NaN]) {
      const err = (() => {
        try {
          computeLadder(linear, { ...item, listUnitPaise, floorUnitPaise: 0 });
        } catch (e) {
          return e as Error;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(PricingMisconfiguredError);
      expect(err).toMatchObject({ name: 'PricingMisconfiguredError', message: 'List price must be a positive integer' });
    }
    for (const quantity of [0, -1, 1.5]) {
      expect(() => computeLadder(linear, { ...item, quantity })).toThrow(new RangeError('Quantity must be at least 1'));
    }
    expect(() => computeLadder(linear, { ...item, floorUnitPaise: 100_001 })).toThrow('Floor price is above the list price');
    expect(computeLadder(linear, { ...item, floorUnitPaise: 100_000 }).maxRounds).toBe(0);
    expect(() => decideOffer(linear, ladder, at(0, 100_000), 0)).toThrow(new RangeError('Offer must be a positive amount in paise'));
  });

  it('accepts at the ask when the offer meets it', () => {
    expect(decideOffer(linear, ladder, at(0, 100_000), 100_000)).toEqual({
      kind: 'accept',
      unitPaise: 100_000,
      round: 0,
      final: true,
      reasonCodes: ['offer_meets_ask'],
    });
    expect(decideOffer(linear, ladder, at(1, 96_700), 120_000).unitPaise).toBe(96_700);
  });

  it("accepts the buyer's own price once it reaches the next ask", () => {
    expect(decideOffer(linear, ladder, at(0, 100_000), 96_700)).toEqual({
      kind: 'accept',
      unitPaise: 96_700,
      round: 1,
      final: true,
      reasonCodes: ['within_policy'],
    });
  });

  it('counters with the next ask, flags lowballs under 60% of the minimum and marks the last counter final', () => {
    expect(decideOffer(linear, ladder, at(0, 100_000), 96_699)).toEqual({
      kind: 'counter',
      unitPaise: 96_700,
      round: 1,
      final: false,
      reasonCodes: ['counter'],
    });
    expect(decideOffer(linear, ladder, at(0, 100_000), 54_000).reasonCodes).toEqual(['counter']);
    expect(decideOffer(linear, ladder, at(0, 100_000), 63_000).reasonCodes).toEqual(['counter']);
    expect(decideOffer(linear, ladder, at(0, 100_000), 53_999).reasonCodes).toEqual(['lowball', 'counter']);
    expect(decideOffer(linear, ladder, at(1, 96_700), 90_000)).toMatchObject({ kind: 'counter', unitPaise: 93_400, round: 2, final: false });
    expect(decideOffer(linear, ladder, at(2, 93_400), 80_000)).toEqual({
      kind: 'counter',
      unitPaise: 90_000,
      round: 3,
      final: true,
      reasonCodes: ['final_offer'],
    });
    // The ask never goes back up, even if the ladder would allow a higher one.
    expect(decideOffer(linear, ladder, at(0, 95_000), 80_000).unitPaise).toBe(95_000);
  });

  it('rejects once the rounds are used up, or at once for a fixed price', () => {
    expect(decideOffer(linear, ladder, at(3, 90_000), 80_000)).toEqual({
      kind: 'reject',
      unitPaise: 90_000,
      round: 3,
      final: true,
      reasonCodes: ['rounds_exhausted'],
    });
    const fixed = computeLadder(linear, { ...item, customized: true });
    expect(fixed).toEqual({ openingUnit: 100_000, minUnit: 100_000, maxRounds: 0, exponent: 1 });
    expect(decideOffer(linear, fixed, at(0, 100_000), 90_000)).toEqual({
      kind: 'reject',
      unitPaise: 100_000,
      round: 0,
      final: true,
      reasonCodes: ['fixed_price'],
    });
  });

  it('sends a deal to a human only when the total discount is strictly above the threshold', () => {
    // Accepting 96,700 on two units is a 6,600 paise discount off the opening.
    const at6600 = { ...linear, approvalThresholdPaise: 6_600 };
    expect(decideOffer(at6600, ladder, at(0, 100_000, 2), 96_700)).toMatchObject({ kind: 'accept', reasonCodes: ['within_policy'] });
    expect(decideOffer({ ...linear, approvalThresholdPaise: 6_599 }, ladder, at(0, 100_000, 2), 96_700)).toEqual({
      kind: 'approval',
      unitPaise: 96_700,
      round: 1,
      final: true,
      reasonCodes: ['within_policy', 'needs_human_approval'],
    });
    expect(decideOffer({ ...linear, approvalThresholdPaise: 0 }, ladder, at(0, 100_000, 2), 100_000).kind).toBe('accept');
    expect(decideOffer({ ...linear, approvalThresholdPaise: 0 }, ladder, at(1, 96_700, 1), 96_700)).toMatchObject({
      kind: 'approval',
      reasonCodes: ['offer_meets_ask', 'needs_human_approval'],
    });
  });

  describe('volume alternatives', () => {
    const tiered: BandPolicy = {
      ...linear,
      volumeTiers: [
        { minQty: 10, extraBps: 700 },
        { minQty: 3, extraBps: 200 },
        { minQty: 1001, extraBps: 950 },
        { minQty: 5, extraBps: 400 },
        { minQty: 1000, extraBps: 900 },
      ],
    };
    const vol = (quantity: number, currentUnit: number, max?: number) => volumeAlternatives(tiered, { ...item, quantity }, 0, currentUnit, max);

    it('offers the next larger tiers in ascending order, two by default', () => {
      expect(vol(1, 100_000)).toEqual([
        { quantity: 3, unitPricePaise: 98_000, reason: 'volume' },
        { quantity: 5, unitPricePaise: 96_000, reason: 'volume' },
      ]);
      expect(vol(3, 100_000)).toEqual([
        { quantity: 5, unitPricePaise: 96_000, reason: 'volume' },
        { quantity: 10, unitPricePaise: 93_000, reason: 'volume' },
      ]);
      expect(vol(5, 100_000, 1)).toEqual([{ quantity: 10, unitPricePaise: 93_000, reason: 'volume' }]);
    });

    it('stops at 1,000 units and skips tiers that are not cheaper than now', () => {
      expect(vol(5, 100_000, 5).map((a) => a.quantity)).toEqual([10, 1000]);
      expect(vol(3, 96_000, 5).map((a) => a.quantity)).toEqual([10, 1000]);
      expect(vol(1000, 100_000, 5)).toEqual([]);
    });
  });
});
