import { z } from 'zod';

/** Contracts for services/ai (FastAPI). snake_case because Python owns the other side. */
export const Intent = z.enum([
  'greeting',
  'search',
  'product_question',
  'availability',
  'customization',
  'ask_price',
  'make_offer',
  'accept',
  'order_status',
  'return_request',
  'complaint',
  'competitor_claim',
  'human_handoff',
  'injection_attempt',
  'off_topic',
  'unknown',
]);
export type Intent = z.infer<typeof Intent>;

export const Level = z.enum(['low', 'medium', 'high']);
export type Level = z.infer<typeof Level>;

export const DetectedLanguage = z.enum(['en', 'hi', 'hinglish', 'other']);
export type DetectedLanguage = z.infer<typeof DetectedLanguage>;

export const ClassifyRequest = z.object({
  text: z.string().max(4000),
  language_hint: z.enum(['en', 'hi']).optional(),
});
export type ClassifyRequest = z.infer<typeof ClassifyRequest>;

export const ClassifyResponse = z.object({
  intent: Intent,
  complexity: Level,
  risk: Level,
  language: DetectedLanguage,
  confidence: z.number().min(0).max(1),
  entities: z.object({
    amount_inr: z.number().nullable(),
    quantity: z.number().int().nullable(),
  }),
  model: z.string(),
});
export type ClassifyResponse = z.infer<typeof ClassifyResponse>;

export const EmbedRequest = z.object({ texts: z.array(z.string().max(2000)).min(1).max(64) });
export const EmbedResponse = z.object({
  model: z.string(),
  dim: z.number().int().min(1),
  vectors: z.array(z.array(z.number())),
});
export type EmbedResponse = z.infer<typeof EmbedResponse>;

export const RedactRequest = z.object({ text: z.string().max(20_000) });
export const RedactFinding = z.object({ type: z.string(), start: z.number().int(), end: z.number().int() });
export const RedactResponse = z.object({ text: z.string(), findings: z.array(RedactFinding) });
export type RedactResponse = z.infer<typeof RedactResponse>;

export const AI_CONTRACTS = {
  ClassifyRequest,
  ClassifyResponse,
  EmbedRequest,
  EmbedResponse,
  RedactRequest,
  RedactResponse,
} as const;
