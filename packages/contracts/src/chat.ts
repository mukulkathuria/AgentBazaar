import { z } from 'zod';
import { Language, Uuid } from './common.js';
import { ProductSummary } from './catalog.js';
import { NegotiationOutcome } from './pricing.js';
import { Intent } from './ai.js';

export const ChatStartInput = z.strictObject({ language: Language.default('en') });
export const ChatSessionView = z.object({ sessionId: Uuid, language: Language, greeting: z.string() });

export const ChatMessageInput = z.strictObject({ text: z.string().trim().min(1).max(1000) });

export const RouterTier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type RouterTier = z.infer<typeof RouterTier>;

export const ChatReply = z.object({
  sessionId: Uuid,
  message: z.string(),
  tier: RouterTier,
  intent: Intent,
  products: z.array(ProductSummary),
  negotiation: NegotiationOutcome.nullable(),
  handoff: z.boolean(),
  tokensRemaining: z.number().int(),
});
export type ChatReply = z.infer<typeof ChatReply>;
