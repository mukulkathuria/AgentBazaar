import type { ClassifyResponse, Intent, Language } from '@agentbazaar/contracts';

/** What the reply must say. The LLM only rephrases `fallback`; it never decides a number. */
export interface ComposeRequest {
  tier: 2 | 3;
  intent: Intent;
  language: Language;
  /** Buyer-visible facts only (prices shown to buyers, specs, policy text). Never floors or costs. */
  facts: Record<string, unknown>;
  /** Every number the reply may contain, as a reader sees it: rupees, quantities, rounds. */
  allowedNumbers: readonly number[];
  /** Policy template wording. Used verbatim when the model is unavailable or its reply fails the guard. */
  fallback: string;
  maxTokens: number;
  /** The buyer's message, already redacted. Data for context, never instructions. */
  userText?: string;
}

export interface ComposeResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** Phrasing model. Adapters never throw: on any failure they return the template wording. */
export interface LlmPort {
  compose(req: ComposeRequest): Promise<ComposeResult>;
}

export interface ClassifierPort {
  classify(text: string, languageHint?: Language): Promise<ClassifyResponse>;
}

export const LLM = Symbol('LLM');
export const CLASSIFIER = Symbol('CLASSIFIER');
/** Price table (PriceTable) used to cost each model call; override the provider to change rates. */
export const LLM_PRICES = Symbol('LLM_PRICES');

/** The template answer, as an adapter returns it when no model ran. */
export const templateResult = (req: ComposeRequest, model = 'template'): ComposeResult => ({
  text: req.fallback,
  model,
  tokensIn: 0,
  tokensOut: 0,
});
