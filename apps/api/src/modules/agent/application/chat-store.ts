import { Inject, Injectable } from '@nestjs/common';
import type { HandoffView, Language } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import { DB } from '../../../shared/kernel/tokens.js';
import { redact } from '../../../shared/observability/redact.js';
import { AuditService } from '../../audit/index.js';
import type { Spend } from '../domain/budget.js';

/** Compact conversation state. The transcript is never replayed to a model; this is all a chat remembers. */
export interface ChatState {
  language: Language;
  lastSku?: string;
  lastQuantity?: number;
  negotiationId?: string;
  /** Negotiation round reached, for the late-round escalation. */
  round?: number;
  /** The latest quote, for big-cart checks and replies to competitor claims. */
  cart?: { sku: string; quantity: number; unitPaise: number };
  constraints: { maxPricePaise?: number };
  injections?: number;
  complaints?: number;
}

export interface ChatSession {
  id: string;
  subject: string;
  channel: string;
  state: ChatState;
  spend: Spend;
}

type Handoff = z.infer<typeof HandoffView>;

interface HandoffRow {
  id: string;
  session_id: string;
  reason: string;
  status: 'open' | 'resolved';
  created_at: Date;
}

const handoffView = (h: HandoffRow): Handoff => ({
  id: h.id,
  sessionId: h.session_id,
  reason: h.reason,
  status: h.status,
  createdAt: h.created_at.toISOString(),
});

/** Chat sessions, redacted messages and human handoffs. */
@Injectable()
export class ChatStore {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(id: string, subject: string, channel: string, language: Language): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO chat_sessions (id, subject, channel, language, state)
          VALUES (${id}, ${subject}, ${channel}, ${language}, ${json({ language, constraints: {} })})`,
    );
  }

  async load(id: string): Promise<ChatSession | null> {
    const r = await one<{ id: string; subject: string; channel: string; language: Language; state: Partial<ChatState>; tokens_used: number; cost_micro_inr: number }>(
      this.db,
      sql`SELECT id, subject, channel, language, state, tokens_used, cost_micro_inr FROM chat_sessions WHERE id = ${id}`,
    );
    if (!r) return null;
    return {
      id: r.id,
      subject: r.subject,
      channel: r.channel,
      state: { constraints: {}, ...r.state, language: r.state.language ?? r.language },
      spend: { tokens: r.tokens_used, costMicroInr: r.cost_micro_inr },
    };
  }

  // shortcut: two messages sent to one chat at the same moment race on `state` (last write wins); add a
  // version column if clients ever send turns in parallel. Spend is incremented atomically either way.
  async saveTurn(id: string, state: ChatState, turn: { buyer: string; seller: string; tier: number; intent: string }): Promise<void> {
    await inTransaction(this.db, async (tx) => {
      await tx.execute(
        sql`INSERT INTO chat_messages (session_id, role, text_redacted, tier, intent)
            VALUES (${id}, 'buyer', ${redact(turn.buyer)}, ${turn.tier}, ${turn.intent}),
                   (${id}, 'seller', ${redact(turn.seller)}, ${turn.tier}, ${turn.intent})`,
      );
      await tx.execute(
        sql`UPDATE chat_sessions SET state = ${json(state)}, language = ${state.language}, turns = turns + 1, updated_at = now()
            WHERE id = ${id}`,
      );
    });
  }

  async addSpend(id: string, tokens: number, costMicroInr: number): Promise<Spend> {
    const r = await one<{ tokens_used: number; cost_micro_inr: number }>(
      this.db,
      sql`UPDATE chat_sessions SET tokens_used = tokens_used + ${tokens}, cost_micro_inr = cost_micro_inr + ${costMicroInr}
          WHERE id = ${id} RETURNING tokens_used, cost_micro_inr`,
    );
    return { tokens: r?.tokens_used ?? tokens, costMicroInr: r?.cost_micro_inr ?? costMicroInr };
  }

  /** At most one open handoff per chat; a second request while one is open is a no-op. */
  async openHandoff(sessionId: string, reason: string): Promise<void> {
    await this.db.execute(sql`INSERT INTO handoffs (session_id, reason) VALUES (${sessionId}, ${reason}) ON CONFLICT DO NOTHING`);
  }

  async listHandoffs(): Promise<Handoff[]> {
    const r = await rows<HandoffRow>(
      this.db,
      sql`SELECT id, session_id, reason, status, created_at FROM handoffs ORDER BY (status = 'open') DESC, created_at DESC LIMIT 200`,
    );
    return r.map(handoffView);
  }

  async resolveHandoff(id: string, actor: string): Promise<Handoff | null> {
    return inTransaction(this.db, async (tx) => {
      const r = await one<HandoffRow>(
        tx,
        sql`UPDATE handoffs SET status = 'resolved', resolved_at = now() WHERE id = ${id} AND status = 'open'
            RETURNING id, session_id, reason, status, created_at`,
      );
      if (r) await this.audit.record(tx, actor, 'chat.handoff_resolved', id, { sessionId: r.session_id });
      return r ? handoffView(r) : null;
    });
  }
}
