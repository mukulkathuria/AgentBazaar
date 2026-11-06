import type { Intent } from '@agentbazaar/contracts';
import { BOTTOM, combine, HIGH_CART_PAISE, LOW_CONFIDENCE, propose, type Route } from './router.js';

/** Output tokens a reply may use, per intent: short answers stay short and cheap. */
export const MAX_TOKENS: Record<Intent, number> = {
  greeting: 120, search: 300, product_question: 350, availability: 150, customization: 300, ask_price: 220,
  make_offer: 220, accept: 150, order_status: 150, return_request: 250, complaint: 300, competitor_claim: 220,
  human_handoff: 120, injection_attempt: 120, off_topic: 120, unknown: 250,
}; // prettier-ignore

/** Model price in micro-rupees per 1,000 tokens. */
export interface ModelPrice {
  inPer1k: number;
  outPer1k: number;
}
export type PriceTable = Readonly<Record<string, ModelPrice>>;

/** Anthropic list prices at ₹88/USD. Self-hosted models cost nothing per token. Override via LLM_PRICES. */
export const DEFAULT_PRICES: PriceTable = {
  'claude-haiku-5-5': { inPer1k: 8_800, outPer1k: 44_000 }, // $0.10 / $0.50 per million tokens
  'claude-sonnet-5-5': { inPer1k: 176_000, outPer1k: 880_000 }, // $2 / $10 per million tokens
};

export function costMicroInr(prices: PriceTable, model: string, tokensIn: number, tokensOut: number): number {
  const p = prices[model];
  return p ? Math.ceil((tokensIn * p.inPer1k + tokensOut * p.outPer1k) / 1000) : 0;
}

/** Per-conversation cap on model spend, alongside the SESSION_TOKEN_BUDGET token cap. */
export const SESSION_COST_BUDGET_MICRO_INR = 5_000_000; // ₹5

export interface Spend {
  tokens: number;
  costMicroInr: number;
}

export const exhausted = (spent: Spend, budget: Spend): boolean =>
  spent.tokens >= budget.tokens || spent.costMicroInr >= budget.costMicroInr;

/** A call that may use `estimate` more tokens still fits the conversation's budget. */
export const fits = (spent: Spend, budget: Spend, estimate: number): boolean =>
  !exhausted(spent, budget) && spent.tokens + estimate <= budget.tokens;

/** Prompt (~4 characters per token) plus the reply's token cap. */
export const estimateTokens = (promptChars: number, maxTokens: number): number => Math.ceil(promptChars / 4) + maxTokens;

export const tokensRemaining = (spent: Spend, budget: Spend): number => Math.max(0, budget.tokens - spent.tokens);

export interface ObserverSignals {
  /** Sending a negotiated price, or handling a warranty or return claim. */
  commitment: boolean;
  confidence: number;
  negotiationRound: number;
  cartValuePaise: number;
  toolFailed: boolean;
  /** The buyer has complained in this conversation. */
  upset: boolean;
}

export const observerTriggered = (s: ObserverSignals): boolean =>
  s.commitment || s.confidence < LOW_CONFIDENCE || s.negotiationRound >= 3 || s.cartValuePaise > HIGH_CART_PAISE || s.toolFailed || s.upset;

/**
 * Lite observer: rules, no model. The caller re-checks the outgoing reply with the guard and swaps
 * in the template if it fails; the observer then escalates. Like router stages it only adds caution.
 */
export function observe(s: ObserverSignals, replyPassedGuard: boolean): Route {
  let r = BOTTOM;
  if (!replyPassedGuard) r = combine(r, propose(3, 'observer_guard'));
  if (s.toolFailed) r = combine(r, propose(3, 'tool_failure'));
  if (s.upset && s.commitment) r = combine(r, propose(4, 'upset_at_commitment'));
  return r;
}

/** Deterministic sample of conversations for human audit (FNV-1a of the session id). */
export function sampledForAudit(sessionId: string, rate = 0.05): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) h = Math.imul(h ^ sessionId.charCodeAt(i), 0x01000193) >>> 0;
  return h / 2 ** 32 < rate;
}
