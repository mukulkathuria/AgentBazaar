import { z } from 'zod';
import { Paise, Uuid } from './common.js';

export const DecisionInput = z.strictObject({
  approve: z.boolean(),
  note: z.string().max(500).optional(),
});

export const ApprovalView = z.object({
  id: Uuid,
  negotiationId: Uuid,
  sku: z.string(),
  productName: z.string(),
  quantity: z.number().int(),
  listUnitPricePaise: Paise,
  requestedUnitPricePaise: Paise,
  discountPaise: Paise,
  status: z.enum(['pending', 'approved', 'declined']),
  createdAt: z.string(),
});

export const ReviewItemView = z.object({
  id: Uuid,
  sku: z.string(),
  field: z.string(),
  text: z.string(),
  flags: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string(),
});

export const HandoffView = z.object({
  id: Uuid,
  sessionId: Uuid,
  reason: z.string(),
  status: z.enum(['open', 'resolved']),
  createdAt: z.string(),
});

export const NegotiationSummaryView = z.object({
  negotiationId: Uuid,
  sku: z.string(),
  channel: z.string(),
  state: z.string(),
  rounds: z.number().int(),
  listUnitPricePaise: Paise,
  finalUnitPricePaise: Paise.nullable(),
  createdAt: z.string(),
  offers: z.array(
    z.object({
      actor: z.enum(['buyer', 'seller']),
      unitPricePaise: Paise,
      quantity: z.number().int(),
      decision: z.string(),
      at: z.string(),
    }),
  ),
});

export const DashboardView = z.object({
  orders: z.object({ total: z.number().int(), paid: z.number().int(), revenuePaise: Paise }),
  negotiations: z.object({
    total: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    avgDiscountBps: z.number(),
    acceptRate: z.number(),
  }),
  agents: z.object({
    conversations: z.number().int(),
    llmCalls: z.number().int(),
    tokens: z.number().int(),
    costPaise: z.number(),
    costPerConversationPaise: z.number(),
    tierCounts: z.record(z.string(), z.number().int()),
  }),
  geo: z.object({
    crawlerHits: z.record(z.string(), z.number().int()),
    aiReferrals: z.record(z.string(), z.number().int()),
  }),
  queues: z.object({
    approvals: z.number().int(),
    reviews: z.number().int(),
    handoffs: z.number().int(),
  }),
});
export type DashboardView = z.infer<typeof DashboardView>;

export const TrackEventInput = z.strictObject({
  kind: z.enum(['crawler_hit', 'ai_referral', 'page_view']),
  path: z.string().max(500),
  agent: z.string().max(60).optional(),
});
