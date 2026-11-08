import { sql } from 'drizzle-orm';
import { one, rows, type Executor } from '../../../shared/db/database.js';

const MICRO_INR_PER_PAISE = 10_000;

/** Admin dashboard: conversations of the last 30 days, their model spend, and which router tier answered each turn. */
export async function conversationStats(ex: Executor) {
  const s = await one<{ conversations: number; tokens: string; cost: string }>(
    ex,
    sql`SELECT count(*)::int AS conversations, coalesce(sum(tokens_used), 0)::text AS tokens,
               coalesce(sum(cost_micro_inr), 0)::text AS cost
        FROM chat_sessions WHERE created_at > now() - interval '30 days'`,
  );
  const tiers = await rows<{ tier: number; n: number }>(
    ex,
    sql`SELECT tier, count(*)::int AS n FROM chat_messages
        WHERE role = 'seller' AND tier IS NOT NULL AND created_at > now() - interval '30 days' GROUP BY tier`,
  );
  const conversations = s?.conversations ?? 0;
  const costPaise = Number(s?.cost ?? 0) / MICRO_INR_PER_PAISE;
  return {
    conversations,
    tokens: Number(s?.tokens ?? 0),
    costPaise,
    costPerConversationPaise: conversations > 0 ? costPaise / conversations : 0,
    tierCounts: Object.fromEntries(tiers.map((t) => [String(t.tier), t.n])),
  };
}

/** Chats escalated to a human and not resolved yet. */
export async function openHandoffs(ex: Executor): Promise<number> {
  return (await one<{ n: number }>(ex, sql`SELECT count(*)::int AS n FROM handoffs WHERE status = 'open'`))?.n ?? 0;
}
