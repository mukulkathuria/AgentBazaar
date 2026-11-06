import type { Intent, Level, RouterTier } from '@agentbazaar/contracts';

/**
 * Which tier handles a turn: 0 rules/cache, 1 classifier + template, 2 small model, 3 large model,
 * 4 a person. A route deliberately has no price, discount or permission field: it can only decide
 * how carefully a reply is written, never what the buyer is offered.
 *
 * Routes form a join-semilattice. Every stage proposes a route and the pipeline joins them, so a
 * stage can raise the tier or deny the request but no stage, in any order, can lower or undo either.
 */
export interface Route {
  readonly tier: RouterTier;
  readonly deny: boolean;
  readonly reasons: ReadonlySet<string>;
}

export const BOTTOM: Route = { tier: 0, deny: false, reasons: new Set() };

export function combine(a: Route, b: Route): Route {
  return { tier: Math.max(a.tier, b.tier) as RouterTier, deny: a.deny || b.deny, reasons: new Set([...a.reasons, ...b.reasons]) };
}

export const propose = (tier: RouterTier, reason: string, deny = false): Route => ({ tier, deny, reasons: new Set([reason]) });

export interface RouteSignals {
  intent: Intent;
  confidence: number;
  complexity: Level;
  /** An exact FAQ answer or a cached reply exists, so no model is needed. */
  answeredByRules: boolean;
  /** Injection attempts in this conversation, including this turn. */
  injections: number;
  /** Complaints in this conversation, including this turn. */
  complaints: number;
  abusive: boolean;
  negotiationRound: number;
  cartValuePaise: number;
  budgetExhausted: boolean;
}

export const LOW_CONFIDENCE = 0.6;
export const HIGH_CART_PAISE = 5_000_000; // ₹50,000

const INTENT_TIER: Record<Intent, RouterTier> = {
  order_status: 0, off_topic: 0,
  greeting: 1, availability: 1, accept: 1, injection_attempt: 1,
  search: 2, product_question: 2, customization: 2, ask_price: 2,
  make_offer: 3, complaint: 3, competitor_claim: 3, return_request: 3, unknown: 3,
  human_handoff: 4,
}; // prettier-ignore

export type Stage = (s: RouteSignals) => Route;

const when = (cond: boolean, route: Route): Route => (cond ? route : BOTTOM);

export const STAGES: readonly Stage[] = [
  // What the intent needs, unless rules or the cache already answer it.
  (s) => propose(s.answeredByRules ? 0 : INTENT_TIER[s.intent], `intent:${s.intent}`),
  // Large model for ambiguity, multi-constraint asks, late negotiation rounds and big carts.
  (s) => when(s.confidence < LOW_CONFIDENCE, propose(3, 'low_confidence')),
  (s) => when(s.complexity === 'high', propose(3, 'multi_constraint')),
  (s) => when(s.negotiationRound >= 3, propose(3, 'late_negotiation_round')),
  (s) => when(s.cartValuePaise > HIGH_CART_PAISE, propose(3, 'high_cart_value')),
  // Never act on injected instructions; an exhausted budget means canned replies only.
  (s) => when(s.intent === 'injection_attempt', propose(1, 'injection', true)),
  (s) => when(s.budgetExhausted, propose(0, 'budget_exhausted', true)),
  // People handle repeated injection, abuse and disputes.
  (s) => when(s.injections >= 2, propose(4, 'repeated_injection', true)),
  (s) => when(s.abusive, propose(4, 'abuse')),
  (s) => when(s.complaints >= 2, propose(4, 'dispute')),
];

export function route(signals: RouteSignals, stages: readonly Stage[] = STAGES): Route {
  return stages.reduce((acc, stage) => combine(acc, stage(signals)), BOTTOM);
}

/** Shadow mode: always use the large model, keep the router's own proposal for comparison. */
export const shadow = (r: Route): Route => combine(r, propose(3, 'shadow_mode'));

const ABUSE = /(?<![\p{L}])(?:idiots?|stupid|moron|wtf|f+u+c+k\w*|bastard|bloody|chutiy\w*|madarchod|bhenchod|behenchod|bhosd\w*|gandu|harami|kamine?|saala)(?![\p{L}])/iu;
/** Insults aimed at the seller go to a person rather than a model. */
export const isAbusive = (text: string): boolean => ABUSE.test(text.normalize('NFKC'));
