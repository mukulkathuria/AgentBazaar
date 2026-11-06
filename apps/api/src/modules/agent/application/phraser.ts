import { Inject, Injectable } from '@nestjs/common';
import type { Intent, Language, RouterTier } from '@agentbazaar/contracts';
import { METRICS } from '../../../shared/kernel/tokens.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import { AuditService } from '../../audit/index.js';
import { costMicroInr, estimateTokens, fits, MAX_TOKENS, type PriceTable, type Spend } from '../domain/budget.js';
import { checkReply, extractNumbers } from '../domain/guard.js';
import { LLM, LLM_PRICES, type LlmPort } from '../domain/ports.js';
import { userPrompt } from '../domain/prompt.js';
import { ChatStore } from './chat-store.js';

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

const SYSTEM_PROMPT_CHARS = 2000;

/**
 * The only place a model writes buyer-facing text. Tiers 2 and 3 get a model; tiers 0 and 1, an
 * exhausted budget, a failed call or a reply that fails the guard all get the template.
 */
@Injectable()
export class Phraser {
  constructor(
    @Inject(LLM) private readonly llm: LlmPort,
    @Inject(LLM_PRICES) private readonly prices: PriceTable,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(ChatStore) private readonly store: ChatStore,
  ) {}

  async phrase(turn: TurnContext, input: PhraseInput): Promise<string> {
    if (turn.tier !== 2 && turn.tier !== 3) return input.fallback;
    const req = { ...input, tier: turn.tier, maxTokens: MAX_TOKENS[input.intent] };
    const prompt = userPrompt(req);
    if (!fits(turn.spend, turn.budget, estimateTokens(prompt.length + SYSTEM_PROMPT_CHARS, req.maxTokens))) return input.fallback;

    const started = Date.now();
    const result = await this.llm.compose(req);
    const verdict = checkReply(result.text, [...input.allowedNumbers, ...extractNumbers(input.fallback)]);
    const cost = costMicroInr(this.prices, result.model, result.tokensIn, result.tokensOut);
    if (result.tokensIn + result.tokensOut > 0) {
      turn.spend = await this.store.addSpend(turn.sessionId, result.tokensIn + result.tokensOut, cost);
    }
    this.metrics.llmTokens.inc({ tier: String(turn.tier), direction: 'in' }, result.tokensIn);
    this.metrics.llmTokens.inc({ tier: String(turn.tier), direction: 'out' }, result.tokensOut);
    await this.audit.trace({
      sessionId: turn.sessionId,
      channel: turn.channel,
      tier: turn.tier,
      shadowTier: turn.shadowTier,
      model: result.model,
      intent: input.intent,
      input: prompt,
      output: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costMicroInr: cost,
      latencyMs: Date.now() - started,
      guardFallback: !verdict.ok,
      sampledForAudit: turn.sampled,
    });
    return verdict.ok ? result.text : input.fallback;
  }
}
