import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import {
  type AgentScope,
  type ChatReply,
  type ChatSessionView,
  type CheckoutLink,
  type ClassifyResponse,
  type Intent,
  type Language,
  type NegotiationOutcome,
  type ProductSummary,
  rupeesToPaise,
} from '@agentbazaar/contracts';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Cache } from '../../../shared/cache/cache.js';
import { sha256Hex } from '../../../shared/crypto/primitives.js';
import type { Principal } from '../../../shared/http/auth.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { CACHE, CONFIG, LOGGER, METRICS } from '../../../shared/kernel/tokens.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import { redact } from '../../../shared/observability/redact.js';
import { exhausted, sampledForAudit, SESSION_COST_BUDGET_MICRO_INR, type Spend, tokensRemaining } from '../domain/budget.js';
import { extractNumbers } from '../domain/guard.js';
import { type ObserverSignals, riskProbes } from '../domain/observer.js';
import { CLASSIFIER, type ClassifierPort } from '../domain/ports.js';
import * as replies from '../domain/replies.js';
import { isAbusive, type Route, route, type RouteSignals, shadow } from '../domain/router.js';
import { findUuid, matchFaq, questionKey, searchTerms, skuCandidates } from '../domain/text.js';
import { type ChatSession, type ChatState, ChatStore } from './chat-store.js';
import { Commerce } from './commerce.js';
import { Phraser, type TurnContext } from './phraser.js';
import { productView } from './views.js';

const { canned } = replies;

/** A handler's answer: template wording plus the facts and numbers a model may use to rephrase it. */
interface Answer {
  fallback: string;
  facts?: Record<string, unknown>;
  allowed?: number[];
  products?: ProductSummary[];
  negotiation?: NegotiationOutcome;
  link?: CheckoutLink;
  /** Sending a price or handling a claim: the observer re-checks the reply. */
  commitment?: boolean;
  toolFailed?: boolean;
  cacheKey?: string;
}

interface Turn {
  session: ChatSession;
  state: ChatState;
  text: string;
  c: ClassifyResponse;
  sku: string | null;
  /** Token scopes of an agent chatting over A2A; the storefront chat has none to check. */
  scopes?: ReadonlySet<AgentScope>;
}

/** Over A2A an agent's token scopes apply to chat too, so free text cannot bypass them. */
const INTENT_SCOPE: Partial<Record<Intent, AgentScope>> = { ask_price: 'quote:create', make_offer: 'quote:create', accept: 'order:create' };

interface Outcome {
  message: string;
  tier: Route['tier'];
  products: ProductSummary[];
  negotiation: NegotiationOutcome | null;
  link: CheckoutLink | null;
  handoff: boolean;
}

const ANSWER_TTL_S = 600;
const A2A_CHAT_TTL_S = 86_400;
const inr = (paise: number) => paise / 100;
const cartValue = (s: ChatState) => (s.cart ? s.cart.unitPaise * s.cart.quantity : 0);
// Tier-0 answer cache: exact repeats of a product question skip the handler. Paraphrases go on to the
// phrasing step, where the semantic cache (SEMANTIC_CACHE, ADR 0012) can reuse guarded model wording.
const answerKey = (sku: string, text: string) => `chat:answer:${sku}:${sha256Hex(questionKey(text)).slice(0, 32)}`;

function negotiated(o: NegotiationOutcome): Answer {
  const q = o.quote;
  const amounts = q ? [q.unitPricePaise, q.totalPaise, q.listUnitPricePaise] : [];
  return {
    fallback: o.message,
    negotiation: o,
    commitment: true,
    facts: {
      decision: o.decision,
      product: q?.productName,
      quantity: q?.quantity,
      unit_price_inr: q && inr(q.unitPricePaise),
      total_inr: q && inr(q.totalPaise),
      rounds_remaining: o.roundsRemaining,
      volume_offers: o.alternatives.map((a) => ({ quantity: a.quantity, unit_price_inr: inr(a.unitPricePaise) })),
    },
    allowed: [...amounts.map(inr), q?.quantity ?? 1, o.roundsRemaining, ...o.alternatives.flatMap((a) => [a.quantity, inr(a.unitPricePaise)])],
  };
}

/**
 * Chat orchestrator. Every turn: classify, route (only ever adding caution), call the store's
 * services for facts and numbers, let a model rephrase the template within the guard, observe,
 * and store a redacted transcript plus a compact state.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(ChatStore) private readonly store: ChatStore,
    @Inject(Phraser) private readonly phraser: Phraser,
    @Inject(Commerce) private readonly shop: Commerce,
    @Inject(CLASSIFIER) private readonly classifier: ClassifierPort,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(CACHE) private readonly cache: Cache,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private get budget(): Spend {
    return { tokens: this.config.env.SESSION_TOKEN_BUDGET, costMicroInr: SESSION_COST_BUDGET_MICRO_INR };
  }

  async start(who: Principal, language: Language): Promise<z.infer<typeof ChatSessionView>> {
    const session = await this.open(who, language, 'chat');
    return { sessionId: session.id, language, greeting: canned.greeting(language, this.config.env.SELLER_NAME) };
  }

  private async open(who: Principal, language: Language, channel: string): Promise<ChatSession> {
    const id = randomUUID();
    // Anonymous web chats get their own subject, so their quotes belong to the chat, not to an IP.
    const subject = who.kind === 'anonymous' && channel === 'chat' ? `chat:${id}` : who.subject;
    await this.store.create(id, subject, channel, language);
    return { id, subject, channel, state: { language, constraints: {} }, spend: { tokens: 0, costMicroInr: 0 } };
  }

  async send(who: Principal, sessionId: string, text: string): Promise<ChatReply> {
    const session = await this.store.load(sessionId);
    // Anonymous chat ids are unguessable capabilities; signed-in chats belong to their owner only.
    if (!session || (!session.subject.startsWith('chat:') && session.subject !== who.subject)) throw notFound('Chat session');
    return (await this.turn(session, text)).reply;
  }

  /** A2A free text: one chat per agent and A2A context, under the agent's own subject. */
  async converse(who: Principal, contextId: string, text: string): Promise<{ reply: ChatReply; link: CheckoutLink | null }> {
    const key = `a2a:chat:${sha256Hex(`${who.subject}|${contextId}`)}`;
    const known = await this.cache.get<string>(key);
    let session = known ? await this.store.load(known) : null;
    if (!session || session.subject !== who.subject) {
      session = await this.open(who, 'en', 'a2a');
      await this.cache.set(key, session.id, A2A_CHAT_TTL_S);
    }
    return this.turn(session, text, who.scopes);
  }

  async handoffs() {
    return this.store.listHandoffs();
  }

  async resolveHandoff(id: string, actor: string) {
    const h = await this.store.resolveHandoff(id, actor);
    if (!h) throw new AppError('conflict', 'Handoff not found or already resolved');
    return h;
  }

  private async turn(session: ChatSession, text: string, scopes?: ReadonlySet<AgentScope>): Promise<{ reply: ChatReply; link: CheckoutLink | null }> {
    const state = session.state;
    const c = await this.classifier.classify(text, state.language);
    // Switch to Hindi when the buyer writes it; mixed text (SKUs, Hinglish) keeps the chosen language.
    if (c.language === 'hi') state.language = 'hi';
    if (c.intent === 'injection_attempt') {
      state.injections = (state.injections ?? 0) + 1;
      // For the SIEM (deploy/siem): never the text itself, only that this session tried again.
      this.logger.warn({ sec: 'agent.injection', sessionId: session.id, channel: session.channel, injections: state.injections }, 'prompt injection flagged');
    }
    if (c.intent === 'complaint') state.complaints = (state.complaints ?? 0) + 1;
    const t: Turn = { session, state, text, c, sku: null, ...(scopes ? { scopes } : {}) };
    const rulesAnswer = await this.rulesAnswer(t);
    const proposed = route(this.signals(t, rulesAnswer !== null));
    const shadowMode = this.config.env.ROUTER_SHADOW_MODE;
    const r = shadowMode ? shadow(proposed) : proposed;
    const ctx: TurnContext = {
      sessionId: session.id,
      channel: session.channel,
      tier: r.tier,
      shadowTier: shadowMode ? proposed.tier : null,
      sampled: sampledForAudit(session.id),
      spend: session.spend,
      budget: this.budget,
    };
    const out = await this.respond(t, r, ctx, rulesAnswer);
    await this.store.saveTurn(session.id, state, { buyer: text, seller: out.message, tier: out.tier, intent: c.intent });
    this.metrics.routerTier.inc({ tier: String(out.tier), intent: c.intent });
    const reply: ChatReply = {
      sessionId: session.id,
      message: out.message,
      tier: out.tier,
      intent: c.intent,
      products: out.products,
      negotiation: out.negotiation,
      checkoutUrl: out.link?.url ?? null,
      handoff: out.handoff,
      tokensRemaining: tokensRemaining(ctx.spend, this.budget),
    };
    return { reply, link: out.link };
  }

  private signals(t: Turn, answeredByRules: boolean): RouteSignals {
    return {
      intent: t.c.intent,
      confidence: t.c.confidence,
      complexity: t.c.complexity,
      answeredByRules,
      injections: t.state.injections ?? 0,
      complaints: t.state.complaints ?? 0,
      abusive: isAbusive(t.text),
      negotiationRound: t.state.round ?? 0,
      cartValuePaise: cartValue(t.state),
      budgetExhausted: exhausted(t.session.spend, this.budget),
    };
  }

  /** Tier 0: an exact FAQ answer or a cached answer to the same product question. */
  private async rulesAnswer(t: Turn): Promise<string | null> {
    if (t.c.intent !== 'product_question') return null;
    try {
      t.sku = await this.resolveSku(t);
      if (!t.sku) return null;
      const cached = await this.cache.get<string>(answerKey(t.sku, t.text));
      return cached ?? matchFaq((await this.shop.catalog.resolve(t.sku)).faqs, t.text);
    } catch {
      return null; // the handler will report the problem
    }
  }

  private async respond(t: Turn, r: Route, ctx: TurnContext, rulesAnswer: string | null): Promise<Outcome> {
    const lang = t.state.language;
    const early = this.earlyAnswer(r, lang, rulesAnswer);
    const a = early ?? (await this.answer(t));
    const phrased = early
      ? early.fallback
      : await this.phraser.phrase(ctx, {
          intent: t.c.intent,
          language: lang,
          facts: a.facts ?? {},
          allowedNumbers: a.allowed ?? [],
          fallback: a.fallback,
          userText: redact(t.text),
        });
    const out = { intent: t.c.intent, language: lang, message: phrased, fallback: a.fallback, allowed: a.allowed ?? [] };
    const { message, final } = await this.phraser.review(ctx, this.observerSignals(t, a, r), out, r);
    const handoff = final.tier === 4;
    if (handoff) await this.store.openHandoff(t.session.id, [...final.reasons].join(','));
    const text = handoff && r.tier !== 4 ? `${message} ${canned.handoff(lang)}` : message;
    if (a.cacheKey && !a.toolFailed) await this.cache.set(a.cacheKey, text, ANSWER_TTL_S);
    return { message: text, tier: final.tier, products: a.products ?? [], negotiation: a.negotiation ?? null, link: a.link ?? null, handoff };
  }

  /** Replies that need no handler: a person takes over, the router refused, or rules already answered. */
  private earlyAnswer(r: Route, lang: Language, rulesAnswer: string | null): Answer | null {
    if (r.tier === 4) return { fallback: canned.handoff(lang) };
    if (r.deny) return { fallback: r.reasons.has('budget_exhausted') ? canned.budgetExhausted(lang) : canned.refuseInstructions(lang) };
    return rulesAnswer !== null && r.tier === 0 ? { fallback: rulesAnswer } : null;
  }

  private observerSignals(t: Turn, a: Answer, r: Route): ObserverSignals {
    return {
      commitment: a.commitment ?? false,
      confidence: t.c.confidence,
      negotiationRound: a.negotiation?.round ?? 0,
      cartValuePaise: cartValue(t.state),
      toolFailed: a.toolFailed ?? false,
      upset: (t.state.complaints ?? 0) > 0,
      risk: t.c.risk,
      denied: r.deny,
      handoff: r.tier === 4,
      probes: riskProbes(t.text),
    };
  }

  private async answer(t: Turn): Promise<Answer> {
    const needed = INTENT_SCOPE[t.c.intent];
    if (needed && t.scopes && !t.scopes.has(needed)) return { fallback: `That needs an agent token with the "${needed}" scope.` };
    try {
      return await this.handle(t);
    } catch (err) {
      if (err instanceof AppError && err.status < 500) return { fallback: err.message };
      if (err instanceof RangeError) return { fallback: err.message };
      this.logger.warn({ err, intent: t.c.intent }, 'chat tool call failed');
      return { fallback: canned.failed(t.state.language), toolFailed: true };
    }
  }

  private handle(t: Turn): Promise<Answer> {
    const lang = t.state.language;
    switch (t.c.intent) {
      case 'greeting':
        return Promise.resolve({ fallback: canned.greeting(lang, this.config.env.SELLER_NAME) });
      case 'search':
        return this.search(t);
      case 'product_question':
        return this.productQuestion(t);
      case 'availability':
        return this.availability(t);
      case 'customization':
        return this.customization(t);
      case 'ask_price':
        return this.quote(t);
      case 'make_offer':
        return this.offer(t);
      case 'accept':
        return this.accept(t);
      case 'competitor_claim':
        return Promise.resolve(this.competitorClaim(t));
      case 'order_status':
        return this.orderStatus(t);
      case 'return_request':
        return Promise.resolve({ fallback: canned.returns(lang), commitment: true });
      case 'complaint':
        return Promise.resolve({ fallback: canned.complaint(lang) });
      case 'off_topic':
        return Promise.resolve({ fallback: canned.offTopic(lang) });
      default:
        return Promise.resolve({ fallback: canned.capabilities(lang) });
    }
  }

  /**
   * Explicit SKU, else a product named by the buyer's words, else the product under discussion
   * (follow-ups like "does it work with a Mac?"), else the best search hit.
   */
  private async resolveSku(t: Turn): Promise<string | null> {
    if (t.sku) return t.sku;
    for (const candidate of skuCandidates(t.text)) {
      const v = await this.shop.catalog.findVariant(candidate);
      if (v) return v.sku;
    }
    const q = searchTerms(t.text);
    const hit = q ? (await this.shop.search.search({ q, limit: 1 })).items[0] : undefined;
    const named = hit && q.split(' ').some((w) => w.length >= 3 && hit.name.toLowerCase().includes(w));
    return (named ? hit.defaultSku : undefined) ?? t.state.lastSku ?? hit?.defaultSku ?? null;
  }

  private async search(t: Turn): Promise<Answer> {
    const amount = t.c.entities.amount_inr;
    const maxPricePaise = amount === null ? t.state.constraints.maxPricePaise : rupeesToPaise(amount);
    t.state.constraints = maxPricePaise === undefined ? {} : { maxPricePaise };
    const { items } = await this.shop.search.search({ q: searchTerms(t.text), maxPricePaise, inStockOnly: true, limit: 5 });
    if (items[0]) t.state.lastSku = items[0].defaultSku;
    return {
      fallback: replies.searchResults(items, t.state.language),
      facts: { results: items.map((p) => ({ name: p.name, sku: p.defaultSku, brand: p.brand, price_inr: inr(p.minPricePaise) })) },
      allowed: [...items.map((p) => inr(p.minPricePaise)), ...items.map((_, i) => i + 1)],
      products: items,
    };
  }

  private async productQuestion(t: Turn): Promise<Answer> {
    const sku = await this.resolveSku(t);
    if (!sku) return { fallback: canned.needProduct(t.state.language) };
    const p = await this.shop.catalog.resolve(sku);
    t.state.lastSku = sku;
    const view = productView(p);
    return {
      fallback: replies.productAnswer(p, matchFaq(p.faqs, t.text), t.state.language),
      facts: { product: view },
      allowed: extractNumbers(JSON.stringify(view)),
      cacheKey: answerKey(sku, t.text),
    };
  }

  private async availability(t: Turn): Promise<Answer> {
    const sku = await this.resolveSku(t);
    if (!sku) return { fallback: canned.needProduct(t.state.language) };
    const quantity = t.c.entities.quantity ?? 1;
    const [a, v] = await Promise.all([this.shop.catalog.availabilityFor(sku, quantity), this.shop.catalog.requireVariant(sku)]);
    t.state.lastSku = sku;
    return { fallback: replies.availability(a, v.productName, t.state.language), allowed: [a.availableQty, quantity] };
  }

  private async customization(t: Turn): Promise<Answer> {
    const sku = await this.resolveSku(t);
    if (!sku) return { fallback: canned.needProduct(t.state.language) };
    const [o, v] = await Promise.all([this.shop.customization.options(sku), this.shop.catalog.requireVariant(sku)]);
    t.state.lastSku = sku;
    let fallback = replies.customization(o, v.productName, t.state.language);
    const quoted = /["“]([^"”]{1,60})["”]/.exec(t.text)?.[1];
    if (quoted && o.fields[0]) {
      const verdict = await this.shop.customization.validate(sku, { text: { [o.fields[0].key]: quoted } });
      fallback = `${fallback} ${replies.customizationVerdict(verdict, t.state.language)}`;
    }
    return { fallback, allowed: [...o.fields.map((f) => f.maxLength), inr(o.surchargePaise)] };
  }

  private remember(t: Turn, o: NegotiationOutcome): void {
    t.state.negotiationId = o.negotiationId;
    t.state.round = o.round;
    if (o.quote) {
      t.state.lastSku = o.quote.sku;
      t.state.lastQuantity = o.quote.quantity;
      t.state.cart = { sku: o.quote.sku, quantity: o.quote.quantity, unitPaise: o.quote.unitPricePaise };
    }
  }

  private async quote(t: Turn): Promise<Answer> {
    const sku = await this.resolveSku(t);
    if (!sku) return { fallback: canned.needProduct(t.state.language) };
    const quantity = t.c.entities.quantity ?? t.state.lastQuantity ?? 1;
    const o = await this.shop.negotiations.requestQuote(t.session.subject, 'chat', { sku, quantity }, t.state.language);
    this.remember(t, o);
    return negotiated(o);
  }

  private async offer(t: Turn): Promise<Answer> {
    const amount = t.c.entities.amount_inr;
    if (amount === null) return this.quote(t);
    if (!t.state.negotiationId) {
      const opened = await this.quote(t);
      if (!t.state.negotiationId) return opened;
    }
    try {
      const o = await this.shop.negotiations.makeOffer(
        t.session.subject,
        t.state.negotiationId,
        { unitPricePaise: rupeesToPaise(amount), quantity: t.c.entities.quantity ?? undefined, message: redact(t.text).slice(0, 1000) },
        t.state.language,
      );
      this.remember(t, o);
      return negotiated(o);
    } catch (err) {
      // A closed or expired negotiation cannot take more offers; the next price ask opens a new one.
      if (err instanceof AppError && ['quote_expired', 'negotiation_closed', 'not_found'].includes(err.code)) delete t.state.negotiationId;
      throw err;
    }
  }

  private async accept(t: Turn): Promise<Answer> {
    const nid = t.state.negotiationId;
    const token = nid ? await this.shop.negotiations.activeQuoteToken(t.session.subject, nid) : null;
    if (!token) return { fallback: canned.noQuote(t.state.language) };
    const link = await this.shop.checkoutLink(t.session.subject, token);
    delete t.state.negotiationId;
    delete t.state.cart;
    return { fallback: replies.checkoutReady(link, t.state.language), link, allowed: [inr(link.amountPaise)], commitment: true };
  }

  /** Unverified claims are acknowledged but never move the price; the claimed number is not even repeated. */
  private competitorClaim(t: Turn): Answer {
    const unit = t.state.cart?.unitPaise ?? null;
    return { fallback: replies.competitorClaim(unit, t.state.language), allowed: unit === null ? [] : [inr(unit)] };
  }

  private async orderStatus(t: Turn): Promise<Answer> {
    const id = findUuid(t.text);
    if (!id) return { fallback: canned.askOrderId(t.state.language) };
    try {
      return { fallback: replies.orderStatus(await this.shop.orders.getForSubject(t.session.subject, id), t.state.language) };
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found') return { fallback: canned.orderNotFound(t.state.language) };
      throw err;
    }
  }
}
