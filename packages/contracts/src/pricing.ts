import { z } from 'zod';
import { Currency, Paise, Quantity, Uuid } from './common.js';
import { CustomizationValues } from './customization.js';

export const NegotiationState = z.enum([
  'inquiry',
  'quote',
  'counter',
  'pending_approval',
  'accepted',
  'rejected',
  'expired',
  'checkout',
]);
export type NegotiationState = z.infer<typeof NegotiationState>;

export const QuoteStatus = z.enum(['active', 'superseded', 'used', 'expired', 'revoked']);
export type QuoteStatus = z.infer<typeof QuoteStatus>;

export const QuoteView = z.object({
  quoteId: Uuid,
  /** Signed, tamper-evident token. Present it to accept the quote. */
  token: z.string(),
  negotiationId: Uuid,
  sku: z.string(),
  productName: z.string(),
  quantity: Quantity,
  unitPricePaise: Paise,
  listUnitPricePaise: Paise,
  totalPaise: Paise,
  currency: Currency,
  expiresAt: z.string(),
  status: QuoteStatus,
  terms: z.array(z.string()),
});
export type QuoteView = z.infer<typeof QuoteView>;

export const RequestQuoteInput = z.strictObject({
  sku: z.string().min(2).max(64),
  quantity: Quantity,
  customization: CustomizationValues.optional(),
});
export type RequestQuoteInput = z.infer<typeof RequestQuoteInput>;

export const MakeOfferInput = z.strictObject({
  negotiationId: Uuid,
  unitPricePaise: Paise,
  quantity: Quantity.optional(),
  /** Free text is stored as data and never used as an instruction. */
  message: z.string().max(1000).optional(),
});
export type MakeOfferInput = z.infer<typeof MakeOfferInput>;

export const NegotiationDecision = z.enum(['quoted', 'accepted', 'countered', 'rejected', 'pending_approval']);
export type NegotiationDecision = z.infer<typeof NegotiationDecision>;

export const TradeAlternative = z.object({
  quantity: Quantity,
  unitPricePaise: Paise,
  reason: z.enum(['volume']),
});
export type TradeAlternative = z.infer<typeof TradeAlternative>;

export const NegotiationOutcome = z.object({
  negotiationId: Uuid,
  state: NegotiationState,
  decision: NegotiationDecision,
  quote: QuoteView.nullable(),
  alternatives: z.array(TradeAlternative),
  round: z.number().int().min(0),
  roundsRemaining: z.number().int().min(0),
  /** Human-readable reply. Every number in it comes from the policy engine. */
  message: z.string(),
  reasonCodes: z.array(z.string()),
});
export type NegotiationOutcome = z.infer<typeof NegotiationOutcome>;

export const VolumeTier = z.object({
  minQty: z.number().int().min(2),
  extraBps: z.number().int().min(0).max(5000),
});

export const DiscountPolicyInput = z.strictObject({
  band: z.enum(['fixed', 'standard', 'premium']),
  negotiableBps: z.number().int().min(0).max(5000),
  volumeTiers: z.array(VolumeTier).max(10),
  maxRounds: z.number().int().min(0).max(10),
  approvalThresholdPaise: Paise.nullable(),
  quoteTtlSeconds: z.number().int().min(60).max(86_400),
  concessionExponent: z.number().min(0.2).max(5),
});
export type DiscountPolicyInput = z.infer<typeof DiscountPolicyInput>;
