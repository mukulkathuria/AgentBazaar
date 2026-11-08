import { Intent, type RouterTier } from '@agentbazaar/contracts';
import { EXTRACTION_CORPUS, INJECTION_CORPUS, PII_CORPUS } from '@agentbazaar/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyRules } from './classifier.js';
import { BOTTOM, combine, isAbusive, route, type Route, type RouteSignals, shadow, STAGES } from './router.js';

const tier = fc.constantFrom<RouterTier>(0, 1, 2, 3, 4);
const anyRoute: fc.Arbitrary<Route> = fc.record({
  tier,
  deny: fc.boolean(),
  reasons: fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 3 }).map((r) => new Set(r)),
});
const signals: fc.Arbitrary<RouteSignals> = fc.record({
  intent: fc.constantFrom(...Intent.options),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  complexity: fc.constantFrom('low' as const, 'medium' as const, 'high' as const),
  answeredByRules: fc.boolean(),
  injections: fc.nat(5),
  complaints: fc.nat(5),
  abusive: fc.boolean(),
  negotiationRound: fc.nat(6),
  cartValuePaise: fc.nat(20_000_000),
  budgetExhausted: fc.boolean(),
});

const same = (a: Route, b: Route) =>
  a.tier === b.tier && a.deny === b.deny && [...a.reasons].sort().join() === [...b.reasons].sort().join();
const atLeast = (hi: Route, lo: Route) => hi.tier >= lo.tier && (!lo.deny || hi.deny) && [...lo.reasons].every((r) => hi.reasons.has(r));

const base: RouteSignals = {
  intent: 'search',
  confidence: 0.9,
  complexity: 'low',
  answeredByRules: false,
  injections: 0,
  complaints: 0,
  abusive: false,
  negotiationRound: 0,
  cartValuePaise: 0,
  budgetExhausted: false,
};

describe('router lattice', () => {
  it('combine is a join: commutative, associative, idempotent, with BOTTOM as identity', () => {
    fc.assert(
      fc.property(anyRoute, anyRoute, anyRoute, (a, b, c) => {
        expect(same(combine(a, b), combine(b, a))).toBe(true);
        expect(same(combine(a, combine(b, c)), combine(combine(a, b), c))).toBe(true);
        expect(same(combine(a, a), a)).toBe(true);
        expect(same(combine(BOTTOM, a), a)).toBe(true);
      }),
    );
  });

  it('no sequence of stages can lower a tier or clear a deny', () => {
    fc.assert(
      fc.property(fc.array(anyRoute, { maxLength: 12 }), (proposals) => {
        let acc = BOTTOM;
        for (const p of proposals) {
          const next = combine(acc, p);
          expect(atLeast(next, acc)).toBe(true);
          expect(atLeast(next, p)).toBe(true);
          acc = next;
        }
      }),
    );
  });

  it('extra stages, in any position and order, never lower the route', () => {
    fc.assert(
      fc.property(signals, fc.shuffledSubarray([...STAGES], { minLength: STAGES.length }), anyRoute, fc.nat(), (s, shuffled, extra, at) => {
        expect(same(route(s, shuffled), route(s))).toBe(true);
        const withExtra = [...shuffled];
        withExtra.splice(at % (withExtra.length + 1), 0, () => extra);
        expect(atLeast(route(s, withExtra), route(s))).toBe(true);
      }),
    );
  });

  it('a route can only carry a tier, a deny flag and reasons, never a price, discount or permission', () => {
    fc.assert(
      fc.property(signals, (s) => {
        const r = route(s);
        expect(Object.keys(r).sort()).toEqual(['deny', 'reasons', 'tier']);
        for (const reason of r.reasons) expect(reason).not.toMatch(/\d/);
      }),
    );
  });

  it('shadow mode always runs the large model and keeps every caution', () => {
    fc.assert(
      fc.property(signals, (s) => {
        const r = route(s);
        const shadowed = shadow(r);
        expect(shadowed.tier).toBeGreaterThanOrEqual(3);
        expect(atLeast(shadowed, r)).toBe(true);
      }),
    );
  });

  it.each([
    ['order_status', 0],
    ['off_topic', 0],
    ['greeting', 1],
    ['availability', 1],
    ['search', 2],
    ['ask_price', 2],
    ['make_offer', 3],
    ['complaint', 3],
    ['human_handoff', 4],
  ] as const)('%s goes to tier %i', (intent, expected) => {
    expect(route({ ...base, intent }).tier).toBe(expected);
  });

  it('answers from rules when an FAQ matches, unless the classifier is unsure', () => {
    expect(route({ ...base, intent: 'product_question', answeredByRules: true }).tier).toBe(0);
    expect(route({ ...base, intent: 'product_question', answeredByRules: true, confidence: 0.4 }).tier).toBe(3);
  });

  it('escalates late negotiation rounds and big carts to the large model', () => {
    expect(route({ ...base, intent: 'ask_price', negotiationRound: 3 }).tier).toBe(3);
    expect(route({ ...base, cartValuePaise: 5_000_001 }).reasons.has('high_cart_value')).toBe(true);
  });

  it('denies injections and hands repeated attempts, abuse and disputes to a person', () => {
    const first = route({ ...base, intent: 'injection_attempt', injections: 1 });
    expect([first.tier, first.deny]).toEqual([1, true]);
    const second = route({ ...base, intent: 'injection_attempt', injections: 2 });
    expect([second.tier, second.deny]).toEqual([4, true]);
    expect(route({ ...base, abusive: true }).tier).toBe(4);
    expect(route({ ...base, intent: 'complaint', complaints: 2 }).tier).toBe(4);
  });

  it('an exhausted budget denies even when the intent needs the large model', () => {
    const r = route({ ...base, intent: 'make_offer', budgetExhausted: true });
    expect(r.deny).toBe(true);
    expect(r.reasons.has('budget_exhausted')).toBe(true);
  });

  it.each([
    ['you idiot', true],
    ['wtf is this', true],
    ['bhai tu chutiya hai', true],
    ['how much is the mug?', false],
    ['this is a stupidly good deal', false],
  ])('isAbusive(%j) = %s', (text, expected) => {
    expect(isAbusive(text)).toBe(expected);
  });

  /** The route of a first message, from the rules classifier's own output. */
  const routeOf = (text: string) => {
    const c = classifyRules(text, 'en');
    return route({ ...base, intent: c.intent, confidence: c.confidence, complexity: c.complexity, injections: Number(c.intent === 'injection_attempt') });
  };

  // Eval regressions (docs/testing/evals.md): these reached a product search or the generic help reply.
  it.each([...INJECTION_CORPUS, ...EXTRACTION_CORPUS, ...PII_CORPUS])('refuses the testkit attack %j without a model', (text) => {
    expect(routeOf(text)).toMatchObject({ tier: 1, deny: true });
  });

  it.each(['thoda aur kam karo', 'can you go a bit lower?', 'थोड़ा और कम करो'])('sends the haggle %j to the large model', (text) => {
    expect(routeOf(text)).toMatchObject({ tier: 3, deny: false });
  });
});
