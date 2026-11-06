import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../shared/db/database.js';
import { json } from '../../shared/db/sql-helpers.js';
import { DB } from '../../shared/kernel/tokens.js';
import { redact, redactDeep } from '../../shared/observability/redact.js';

export interface LlmTrace {
  sessionId: string | null;
  channel: string;
  tier: number;
  shadowTier: number | null;
  /** A phrasing call (the default), the observer's judge call, or a reply reused from the semantic cache. */
  kind?: 'compose' | 'judge' | 'cache';
  model: string;
  intent: string;
  input: string;
  output: string;
  tokensIn: number;
  tokensOut: number;
  costMicroInr: number;
  latencyMs: number;
  guardFallback: boolean;
  sampledForAudit: boolean;
}

/** Append-only audit trail and LLM traces. Everything is PII-redacted before it is stored. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Executor) {}

  async record(ex: Executor | null, actor: string, action: string, target: string | null, data: Record<string, unknown> = {}): Promise<void> {
    await (ex ?? this.db).execute(
      sql`INSERT INTO audit_log (actor, action, target, data) VALUES (${actor}, ${action}, ${target}, ${json(redactDeep(data))})`,
    );
  }

  async trace(t: LlmTrace): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO llm_traces (session_id, channel, tier, shadow_tier, kind, model, intent, input_redacted, output_redacted,
            tokens_in, tokens_out, cost_micro_inr, latency_ms, guard_fallback, sampled_for_audit)
          VALUES (${t.sessionId}, ${t.channel}, ${t.tier}, ${t.shadowTier}, ${t.kind ?? 'compose'}, ${t.model}, ${t.intent}, ${redact(t.input).slice(0, 4000)},
            ${redact(t.output).slice(0, 4000)}, ${t.tokensIn}, ${t.tokensOut}, ${t.costMicroInr}, ${t.latencyMs}, ${t.guardFallback},
            ${t.sampledForAudit})`,
    );
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
