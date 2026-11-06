import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type { Intent, Language, RouterTier } from '@agentbazaar/contracts';
import { CONFIG, METRICS } from '../../../shared/kernel/tokens.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import { AuditService, type LlmTrace } from '../../audit/index.js';
import { costMicroInr, estimateTokens, fits, MAX_TOKENS, type PriceTable, type Spend } from '../domain/budget.js';
import { checkReply, extractNumbers } from '../domain/guard.js';
import { observe, observerReasons, type ObserverSignals } from '../domain/observer.js';
import { type ComposeRequest, type ComposeResult, type JudgeRequest, LLM, LLM_PRICES, type LlmPort } from '../domain/ports.js';
import { JUDGE_MAX_TOKENS, JUDGE_SYSTEM_PROMPT, judgePrompt, userPrompt } from '../domain/prompt.js';
import { combine, type Route } from '../domain/router.js';
import { ChatStore } from './chat-store.js';
import { SemanticCache } from './semantic-cache.js';

export interface PhraseInput {
  intent: Intent;
  language: Language;
  facts: Record<string, unknown>;
  allowedNumbers: readonly number[];
  /** Template wording; what the buyer sees unless a model rephrases it within the guard. */
  fallback: string;
  userText?: string;
}

/** One turn's routing and spend. `spend` is updated after every model call. */
export interface TurnContext {
  sessionId: string;
  channel: string;
  tier: RouterTier;
  shadowTier: RouterTier | null;
  sampled: boolean;
  spend: Spend;
  budget: Spend;
}

/** A reply about to be sent and the template it rephrases. */
export interface Outgoing {
  intent: Intent;
  language: Language;
  /** What would be sent: model wording, a cached reply, or the template itself. */
  message: string;
  /** The policy template, sent instead whenever a check fails. */
  fallback: string;
  allowed: readonly number[];
}

/** Optional exporter of LLM-call traces to an outside tool (Langfuse). It must never throw or delay a reply. */
export interface LlmTracer {
  record(trace: LlmTrace): void;
}
export const TRACER = Symbol('TRACER');

const SYSTEM_PROMPT_CHARS = 2000;

/**
 * The only place a model writes or reviews buyer-facing text. Tiers 2 and 3 get a model; tiers 0 and
 * 1, an exhausted budget, a failed call or a reply that fails the guard all get the template.
 */
@Injectable()
export class Phraser {
  /** Output-token cap per call for each model tier (LLM_TIER2_MAX_TOKENS, LLM_TIER3_MAX_TOKENS). */
  private readonly tierMaxTokens: Readonly<Record<2 | 3, number>>;

  constructor(
    @Inject(LLM) private readonly llm: LlmPort,
    @Inject(LLM_PRICES) private readonly prices: PriceTable,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(ChatStore) private readonly store: ChatStore,
    @Inject(SemanticCache) private readonly cache: SemanticCache,
    @Inject(TRACER) private readonly tracer: LlmTracer,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.tierMaxTokens = { 2: config.env.LLM_TIER2_MAX_TOKENS, 3: config.env.LLM_TIER3_MAX_TOKENS };
  }

  async phrase(turn: TurnContext, input: PhraseInput): Promise<string> {
    if (turn.tier !== 2 && turn.tier !== 3) return input.fallback;
    const req: ComposeRequest = { ...input, tier: turn.tier, maxTokens: Math.min(MAX_TOKENS[input.intent], this.tierMaxTokens[turn.tier]) };
    const allowed = [...input.allowedNumbers, ...extractNumbers(input.fallback)];
    const prompt = userPrompt(req);
    const cached = await this.cache.lookup(req, allowed);
    if (cached.text !== null) {
      await this.record(turn, 'cache', input.intent, prompt, { text: cached.text, model: 'semantic-cache', tokensIn: 0, tokensOut: 0 }, 0, false);
      return cached.text;
    }
    if (!fits(turn.spend, turn.budget, estimateTokens(prompt.length + SYSTEM_PROMPT_CHARS, req.maxTokens))) return input.fallback;

    const started = Date.now();
    const result = await this.llm.compose(req);
    const ok = checkReply(result.text, allowed).ok;
    await this.record(turn, 'compose', input.intent, prompt, result, Date.now() - started, !ok);
    if (ok && result.tokensIn + result.tokensOut > 0) await cached.remember(result.text);
    return ok ? result.text : input.fallback;
  }

  /**
   * Gated observer (ADR 0012). A turn with no risk signal skips it and the model call it may make. On
   * every other turn, model wording is re-checked by the guard and then by the judge, and the turn is
   * recorded in the audit log. Shadow mode observes every turn, to collect labels for tuning the gate.
   * Templates and canned replies are the policy's own words: swapping them for themselves changes nothing.
   */
  async review(turn: TurnContext, signals: ObserverSignals, out: Outgoing, r: Route): Promise<{ message: string; final: Route }> {
    const reasons = observerReasons(signals);
    if (turn.shadowTier !== null) reasons.push('shadow_mode');
    if (!reasons.length) {
      this.metrics.observerTurns.inc({ decision: 'skipped' });
      return { message: out.message, final: r };
    }
    const modelWrote = out.message !== out.fallback;
    const guard = !modelWrote || checkReply(out.message, [...out.allowed, ...extractNumbers(out.fallback)]).ok;
    const judge = !modelWrote || !guard || (await this.judge(turn, { intent: out.intent, language: out.language, template: out.fallback, reply: out.message }));
    const final = combine(r, observe(signals, guard, judge));
    const passed = guard && judge;
    await this.audit.record(null, 'system', 'chat.observed', turn.sessionId, { reasons, guard, judge, tier: final.tier });
    this.metrics.observerTurns.inc({ decision: passed ? 'observed' : 'replaced' });
    return { message: passed ? out.message : out.fallback, final };
  }

  /** The observer's model check of a reply. Fails closed: with no budget or no verdict, the template is sent. */
  private async judge(turn: TurnContext, req: JudgeRequest): Promise<boolean> {
    const prompt = judgePrompt(req);
    if (!fits(turn.spend, turn.budget, estimateTokens(prompt.length + JUDGE_SYSTEM_PROMPT.length, JUDGE_MAX_TOKENS))) return false;
    const started = Date.now();
    const v = await this.llm.judge(req);
    const result = { text: v.ok ? 'PASS' : 'FAIL', model: v.model, tokensIn: v.tokensIn, tokensOut: v.tokensOut };
    await this.record(turn, 'judge', req.intent, prompt, result, Date.now() - started, false);
    return v.ok;
  }

  /** Spend, token metrics, the redacted audit trace and the optional outside trace of one model call. */
  private async record(
    turn: TurnContext,
    kind: NonNullable<LlmTrace['kind']>,
    intent: Intent,
    input: string,
    result: ComposeResult,
    latencyMs: number,
    guardFallback: boolean,
  ): Promise<void> {
    const tokens = result.tokensIn + result.tokensOut;
    const cost = costMicroInr(this.prices, result.model, result.tokensIn, result.tokensOut);
    if (tokens > 0) turn.spend = await this.store.addSpend(turn.sessionId, tokens, cost);
    const tier = kind === 'judge' ? 'observer' : String(turn.tier);
    this.metrics.llmTokens.inc({ tier, direction: 'in' }, result.tokensIn);
    this.metrics.llmTokens.inc({ tier, direction: 'out' }, result.tokensOut);
    const trace: LlmTrace = {
      sessionId: turn.sessionId,
      channel: turn.channel,
      tier: turn.tier,
      shadowTier: turn.shadowTier,
      kind,
      model: result.model,
      intent,
      input,
      output: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costMicroInr: cost,
      latencyMs,
      guardFallback,
      sampledForAudit: turn.sampled,
    };
    await this.audit.trace(trace);
    this.tracer.record(trace);
  }
}
