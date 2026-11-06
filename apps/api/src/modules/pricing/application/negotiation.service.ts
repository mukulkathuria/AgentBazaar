import { Inject, Injectable } from '@nestjs/common';
import {
  type CustomizationValues,
  type DiscountPolicyInput,
  type Language,
  type NegotiationDecision,
  type NegotiationOutcome,
  type NegotiationState,
  type PriceBand,
  type QuoteView,
  type RequestQuoteInput,
  type TradeAlternative,
} from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import { signToken, verifyToken, type KeyRing } from '../../../shared/crypto/keyring.js';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import { addSeconds, type Clock } from '../../../shared/kernel/clock.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { CLOCK, DB, KEYS, METRICS } from '../../../shared/kernel/tokens.js';
import type { Metrics } from '../../../shared/observability/metrics.js';
import { redact } from '../../../shared/observability/redact.js';
import { appendEvent } from '../../../shared/outbox/outbox.js';
import { AuditService } from '../../audit/index.js';
import { CatalogService } from '../../catalog/index.js';
import { CustomizationService } from '../../customization/index.js';
import { displayQty, InventoryService } from '../../inventory/index.js';
import { acceptsOffers, IllegalTransitionError, isTerminal, quoteAcceptable, transition } from '../domain/negotiation-state.js';
import {
  askAt,
  type BandPolicy,
  computeLadder,
  decideOffer,
  guardedFloor,
  type Ladder,
  type LadderInput,
  type OfferDecision,
  PricingMisconfiguredError,
  volumeAlternatives,
} from '../domain/policy.js';
import { describeOutcome } from './messages.js';

export type Channel = 'mcp' | 'a2a' | 'chat' | 'rest';

interface SessionRow {
  id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  subject: string;
  channel: Channel;
  state: NegotiationState;
  band: PriceBand;
  quantity: number;
  list_unit_paise: number;
  opening_unit_paise: number;
  current_ask_paise: number;
  round: number;
  max_rounds: number;
  customization: CustomizationValues | null;
  final_unit_paise: number | null;
  expires_at: Date;
  created_at: Date;
}

interface PolicyRow {
  band: PriceBand;
  negotiable_bps: number;
  volume_tiers: { minQty: number; extraBps: number }[];
  max_rounds: number;
  approval_threshold_paise: number | null;
  quote_ttl_seconds: number;
  concession_exponent: number;
}

interface IssuedQuote {
  quoteId: string;
  token: string;
  expiresAt: Date;
  unit: number;
  quantity: number;
}

interface OutcomeInput {
  s: SessionRow;
  state: NegotiationState;
  decision: NegotiationDecision;
  unit: number;
  quantity: number;
  quote: IssuedQuote | null;
  alternatives: TradeAlternative[];
  reasons: string[];
  ladder: Ladder;
  round: number;
  lang: Language;
}

/** A policy decision on one buyer offer, with the numbers it was made against. */
interface DecidedTurn extends Pick<OutcomeInput, 'decision' | 'state' | 'quantity' | 'ladder'> {
  d: OfferDecision;
  /** The ask the offer was judged against (it stays the ask while a manager decides). */
  askUnit: number;
  policy: BandPolicy;
}

/** What checkout receives when a quote is accepted. */
export interface AcceptedQuote {
  quoteId: string;
  negotiationId: string;
  variantId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPricePaise: number;
  listUnitPaise: number;
  customization: CustomizationValues | null;
}

const APPROVAL_WINDOW_S = 24 * 3600;
const DECISION: Record<string, { decision: NegotiationDecision; state: NegotiationState }> = {
  accept: { decision: 'accepted', state: 'accepted' },
  counter: { decision: 'countered', state: 'counter' },
  reject: { decision: 'rejected', state: 'rejected' },
  approval: { decision: 'pending_approval', state: 'pending_approval' },
};

function toPolicy(r: PolicyRow): BandPolicy {
  return {
    band: r.band,
    negotiableBps: r.negotiable_bps,
    volumeTiers: r.volume_tiers,
    maxRounds: r.max_rounds,
    approvalThresholdPaise: r.approval_threshold_paise,
    quoteTtlSeconds: r.quote_ttl_seconds,
    concessionExponent: r.concession_exponent,
  };
}

/** Domain errors become user-facing errors without leaking internals. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PricingMisconfiguredError) throw new AppError('pricing_misconfigured', 'This item cannot be quoted right now');
    if (e instanceof IllegalTransitionError) throw new AppError('illegal_transition', e.message);
    if (e instanceof RangeError) throw new AppError('validation_failed', e.message);
    throw e;
  }
}

@Injectable()
export class NegotiationService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(KEYS) private readonly keys: KeyRing,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(CustomizationService) private readonly customization: CustomizationService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async policy(band: PriceBand, ex: Executor = this.db): Promise<BandPolicy> {
    const r = await one<PolicyRow>(ex, sql`SELECT * FROM discount_policies WHERE band = ${band}`);
    if (!r) throw new AppError('pricing_misconfigured', `No discount policy for band ${band}`);
    return toPolicy(r);
  }

  private async ensureStock(variantId: string, quantity: number, ex: Executor): Promise<void> {
    const available = (await this.inventory.availability([variantId], ex)).get(variantId) ?? 0;
    if (available < quantity) {
      throw new AppError('out_of_stock', `Only ${displayQty(available)} available right now`, { available: displayQty(available) });
    }
  }

  private async recordOffer(
    tx: Executor,
    negotiationId: string,
    actor: 'buyer' | 'seller',
    unit: number,
    quantity: number,
    decision: string,
    reasons: readonly string[],
    message: string | null,
  ): Promise<void> {
    await tx.execute(
      sql`INSERT INTO offers (negotiation_id, actor, unit_price_paise, quantity, decision, reason_codes, message)
          VALUES (${negotiationId}, ${actor}, ${unit}, ${quantity}, ${decision}, ${`{${reasons.join(',')}}`}::text[], ${message})`,
    );
  }

  private async issueQuote(tx: Executor, s: SessionRow, unit: number, quantity: number, ttlSeconds: number): Promise<IssuedQuote> {
    await tx.execute(sql`UPDATE quotes SET status = 'superseded' WHERE negotiation_id = ${s.id} AND status = 'active'`);
    const expiresAt = addSeconds(this.clock.now(), ttlSeconds);
    const q = await one<{ id: string }>(
      tx,
      sql`INSERT INTO quotes (negotiation_id, variant_id, sku, subject, quantity, unit_price_paise, list_unit_paise, customization, status, expires_at)
          VALUES (${s.id}, ${s.variant_id}, ${s.sku}, ${s.subject}, ${quantity}, ${unit}, ${s.list_unit_paise},
                  ${s.customization ? json(s.customization) : null}, 'active', ${expiresAt})
          RETURNING id`,
    );
    const token = signToken(this.keys.quoteKey, 'quote', { qid: q!.id, nid: s.id, sub: s.subject, exp: Math.floor(expiresAt.getTime() / 1000) });
    return { quoteId: q!.id, token, expiresAt, unit, quantity };
  }

  private quoteView(s: SessionRow, q: IssuedQuote): QuoteView {
    return {
      quoteId: q.quoteId,
      token: q.token,
      negotiationId: s.id,
      sku: s.sku,
      productName: s.product_name,
      quantity: q.quantity,
      unitPricePaise: q.unit,
      listUnitPricePaise: s.list_unit_paise,
      totalPaise: q.unit * q.quantity,
      currency: 'INR',
      expiresAt: q.expiresAt.toISOString(),
      status: 'active',
      terms: [
        'Prices include GST.',
        `Single use; valid until ${q.expiresAt.toISOString()}.`,
        ...(s.customization ? ['Personalised items are non-returnable.'] : []),
        'Payment is confirmed by a person on the checkout page.',
      ],
    };
  }

  private outcome({ s, state, decision, unit, quantity, quote, alternatives, reasons, ladder, round, lang }: OutcomeInput): NegotiationOutcome {
    const expiresAt = quote?.expiresAt ?? s.expires_at;
    return {
      negotiationId: s.id,
      state,
      decision,
      quote: quote ? this.quoteView(s, quote) : null,
      alternatives,
      round,
      roundsRemaining: Math.max(0, ladder.maxRounds - round),
      message: describeOutcome({ decision, productName: s.product_name, quantity, unitPaise: unit, expiresAt, alternatives, reasonCodes: reasons }, lang),
      reasonCodes: reasons,
    };
  }

  async requestQuote(subject: string, channel: Channel, input: RequestQuoteInput, lang: Language = 'en'): Promise<NegotiationOutcome> {
    const variant = await this.catalog.requireVariant(input.sku);
    await this.ensureStock(variant.variantId, input.quantity, this.db);
    let customization: CustomizationValues | null = null;
    let surcharge = 0;
    if (input.customization) {
      const checked = await this.customization.requireAcceptable(input.sku, input.customization);
      customization = checked.validation.normalized;
      surcharge = checked.validation.surchargePaise;
    }
    const snap = await this.catalog.pricingSnapshot(variant.variantId);
    const policy = await this.policy(snap.band);
    const lin: LadderInput = {
      listUnitPaise: snap.listUnitPaise + surcharge,
      floorUnitPaise: snap.floorUnitPaise + surcharge,
      quantity: input.quantity,
      customized: customization !== null,
    };
    const ladder = guarded(() => computeLadder(policy, lin));
    const outcome = await inTransaction(this.db, async (tx) => {
      const expiresAt = addSeconds(this.clock.now(), policy.quoteTtlSeconds);
      const s = await one<SessionRow>(
        tx,
        sql`INSERT INTO negotiation_sessions (variant_id, sku, product_name, subject, channel, state, band, quantity, list_unit_paise,
              opening_unit_paise, current_ask_paise, max_rounds, customization, expires_at)
            VALUES (${variant.variantId}, ${variant.sku}, ${variant.productName}, ${subject}, ${channel}, 'quote', ${snap.band},
              ${input.quantity}, ${lin.listUnitPaise}, ${ladder.openingUnit}, ${ladder.openingUnit}, ${ladder.maxRounds},
              ${customization ? json(customization) : null}, ${expiresAt})
            RETURNING *`,
      );
      await this.recordOffer(tx, s!.id, 'seller', ladder.openingUnit, input.quantity, 'quoted', ['opening'], null);
      const quote = await this.issueQuote(tx, s!, ladder.openingUnit, input.quantity, policy.quoteTtlSeconds);
      const alternatives = volumeAlternatives(policy, lin, 0, ladder.openingUnit);
      return this.outcome({ s: s!, state: 'quote', decision: 'quoted', unit: ladder.openingUnit, quantity: input.quantity, quote, alternatives, reasons: ['opening'], ladder, round: 0, lang });
    });
    this.metrics.negotiationDecisions.inc({ band: snap.band, decision: 'quoted', channel });
    return outcome;
  }

  private async loadForUpdate(tx: Executor, id: string, subject: string): Promise<SessionRow> {
    const s = await one<SessionRow>(tx, sql`SELECT * FROM negotiation_sessions WHERE id = ${id} FOR UPDATE`);
    // Someone else's negotiation looks exactly like a missing one (no IDOR oracle).
    if (!s || s.subject !== subject) throw notFound('Negotiation');
    return s;
  }

  /** Policy and price ladder for a session at a (possibly new) quantity, against today's floor. */
  private async ladderFor(tx: Executor, s: SessionRow, quantity: number): Promise<{ policy: BandPolicy; lin: LadderInput; ladder: Ladder }> {
    const surcharge = s.customization ? (await this.customization.check(s.sku, s.customization, tx)).validation.surchargePaise : 0;
    const snap = await this.catalog.pricingSnapshot(s.variant_id, tx);
    const policy = await this.policy(s.band, tx);
    const lin: LadderInput = { listUnitPaise: s.list_unit_paise, floorUnitPaise: snap.floorUnitPaise + surcharge, quantity, customized: s.customization !== null };
    return { policy, lin, ladder: guarded(() => computeLadder(policy, lin)) };
  }

  /** Issues the quote (or files the approval request), moves the session on, logs the seller's turn and closes it if final. */
  private async persistDecision(tx: Executor, s: SessionRow, t: DecidedTurn): Promise<{ quote: IssuedQuote | null; expiresAt: Date }> {
    const { d, decision, state, quantity } = t;
    const quote = d.kind === 'approval' ? null : await this.issueQuote(tx, s, d.unitPaise, quantity, t.policy.quoteTtlSeconds);
    if (d.kind === 'approval') {
      await tx.execute(
        sql`INSERT INTO pricing_approvals (negotiation_id, requested_unit_paise, quantity) VALUES (${s.id}, ${d.unitPaise}, ${quantity})
            ON CONFLICT DO NOTHING`,
      );
    }
    const expiresAt = quote?.expiresAt ?? addSeconds(this.clock.now(), APPROVAL_WINDOW_S);
    await tx.execute(
      sql`UPDATE negotiation_sessions SET state = ${state}, quantity = ${quantity}, round = ${d.round},
            current_ask_paise = ${d.kind === 'approval' ? t.askUnit : d.unitPaise},
            final_unit_paise = ${d.kind === 'accept' ? d.unitPaise : null}, expires_at = ${expiresAt},
            updated_at = now(), version = version + 1
          WHERE id = ${s.id}`,
    );
    await this.recordOffer(tx, s.id, 'seller', d.unitPaise, quantity, decision, d.reasonCodes, null);
    if (d.kind === 'accept' || d.kind === 'reject') {
      await appendEvent(tx, 'negotiation.closed', s.id, {
        negotiationId: s.id,
        outcome: decision,
        band: s.band,
        discountBps: Math.round((1 - d.unitPaise / t.ladder.openingUnit) * 10_000),
      });
    }
    return { quote, expiresAt };
  }

  async makeOffer(
    subject: string,
    negotiationId: string,
    input: { unitPricePaise: number; quantity?: number | undefined; message?: string | undefined },
    lang: Language = 'en',
  ): Promise<NegotiationOutcome> {
    const result = await inTransaction(this.db, async (tx) => {
      const s = await this.loadForUpdate(tx, negotiationId, subject);
      if (!isTerminal(s.state) && s.expires_at <= this.clock.now()) {
        // Commit the expiry and report it after the transaction: throwing here would roll it back.
        await this.expire(tx, [s.id]);
        return null;
      }
      if (!acceptsOffers(s.state)) throw new AppError('negotiation_closed', `This negotiation is ${s.state.replace('_', ' ')}; no more offers`);
      const qty = input.quantity ?? s.quantity;
      if (qty !== s.quantity) await this.ensureStock(s.variant_id, qty, tx);
      const { policy, lin, ladder } = await this.ladderFor(tx, s, qty);
      const ask = qty === s.quantity ? s.current_ask_paise : askAt(ladder, s.round);
      // If costs rose since the last turn, the ask moves up to the new minimum, never below it.
      const pos = { round: s.round, currentAskUnit: Math.max(Math.min(ask, ladder.openingUnit), ladder.minUnit), quantity: qty };
      const d = guarded(() => decideOffer(policy, ladder, pos, input.unitPricePaise));
      const { decision, state } = DECISION[d.kind]!;
      guarded(() => transition(s.state, state));
      await this.recordOffer(tx, s.id, 'buyer', input.unitPricePaise, qty, 'offer', [], input.message ? redact(input.message).slice(0, 500) : null);
      const { quote, expiresAt } = await this.persistDecision(tx, s, { d, decision, state, quantity: qty, askUnit: pos.currentAskUnit, policy, ladder });
      const alternatives = d.kind === 'counter' || d.kind === 'reject' ? volumeAlternatives(policy, lin, d.round, d.unitPaise) : [];
      return {
        band: s.band,
        channel: s.channel,
        outcome: this.outcome({ s: { ...s, expires_at: expiresAt }, state, decision, unit: d.unitPaise, quantity: qty, quote, alternatives, reasons: d.reasonCodes, ladder, round: d.round, lang }),
      };
    });
    if (!result) throw new AppError('quote_expired', 'This negotiation has expired. Request a new quote.');
    this.metrics.negotiationDecisions.inc({ band: result.band, decision: result.outcome.decision, channel: result.channel });
    return result.outcome;
  }

  /** Verifies and atomically consumes a quote inside the checkout transaction. */
  async acceptQuote(tx: Executor, subject: string, token: string): Promise<AcceptedQuote> {
    const v = verifyToken<{ qid: string; nid: string; sub: string; exp: number }>(this.keys.quoteKey, 'quote', token, this.clock.now());
    if (!v.ok) {
      throw v.reason === 'expired'
        ? new AppError('quote_expired', 'This quote has expired. Ask for a new one.')
        : new AppError('quote_invalid', 'This quote is not valid');
    }
    if (v.payload.sub !== subject) throw new AppError('quote_invalid', 'This quote was issued to someone else');
    const used = await one<{ id: string; negotiation_id: string; variant_id: string; sku: string; quantity: number; unit_price_paise: number; list_unit_paise: number; customization: CustomizationValues | null }>(
      tx,
      sql`UPDATE quotes SET status = 'used', used_at = now()
          WHERE id = ${v.payload.qid} AND status = 'active' AND expires_at > ${this.clock.now()}
          RETURNING id, negotiation_id, variant_id, sku, quantity, unit_price_paise, list_unit_paise, customization`,
    );
    if (!used) {
      const q = await one<{ status: string }>(tx, sql`SELECT status FROM quotes WHERE id = ${v.payload.qid}`);
      if (q?.status === 'used') throw new AppError('quote_used', 'This quote has already been used');
      if (q?.status === 'superseded') throw new AppError('quote_invalid', 'A newer quote replaced this one');
      throw new AppError('quote_expired', 'This quote has expired. Ask for a new one.');
    }
    const s = await this.loadForUpdate(tx, used.negotiation_id, subject);
    if (!quoteAcceptable(s.state)) throw new AppError('negotiation_closed', `This negotiation is ${s.state}`);
    guarded(() => transition(s.state, 'checkout'));
    await tx.execute(sql`UPDATE negotiation_sessions SET state = 'checkout', final_unit_paise = ${used.unit_price_paise}, updated_at = now() WHERE id = ${s.id}`);
    return {
      quoteId: used.id,
      negotiationId: s.id,
      variantId: used.variant_id,
      sku: used.sku,
      productName: s.product_name,
      quantity: used.quantity,
      unitPricePaise: used.unit_price_paise,
      listUnitPaise: used.list_unit_paise,
      customization: used.customization,
    };
  }

  private async expire(tx: Executor, ids: string[]): Promise<void> {
    for (const id of ids) {
      await tx.execute(sql`UPDATE quotes SET status = 'expired' WHERE negotiation_id = ${id} AND status = 'active'`);
      await tx.execute(sql`UPDATE negotiation_sessions SET state = 'expired', updated_at = now() WHERE id = ${id}`);
      await tx.execute(sql`UPDATE pricing_approvals SET status = 'declined', note = 'expired', decided_at = now() WHERE negotiation_id = ${id} AND status = 'pending'`);
    }
  }

  async sweepExpired(ex: Executor = this.db): Promise<number> {
    return inTransaction(ex, async (tx) => {
      const due = await rows<{ id: string }>(
        tx,
        sql`SELECT id FROM negotiation_sessions WHERE state IN ('quote','counter','accepted','rejected','pending_approval')
            AND expires_at <= ${this.clock.now()} ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED`,
      );
      await this.expire(tx, due.map((d) => d.id));
      await tx.execute(sql`UPDATE quotes SET status = 'expired' WHERE status = 'active' AND expires_at <= ${this.clock.now()}`);
      return due.length;
    });
  }

  async listApprovals() {
    const r = await rows<{ id: string; negotiation_id: string; sku: string; product_name: string; quantity: number; list_unit_paise: number; opening_unit_paise: number; requested_unit_paise: number; status: 'pending' | 'approved' | 'declined'; created_at: Date }>(
      this.db,
      sql`SELECT a.id, a.negotiation_id, n.sku, n.product_name, a.quantity, n.list_unit_paise, n.opening_unit_paise,
                 a.requested_unit_paise, a.status, a.created_at
          FROM pricing_approvals a JOIN negotiation_sessions n ON n.id = a.negotiation_id
          ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT 200`,
    );
    return r.map((x) => ({
      id: x.id,
      negotiationId: x.negotiation_id,
      sku: x.sku,
      productName: x.product_name,
      quantity: x.quantity,
      listUnitPricePaise: x.list_unit_paise,
      requestedUnitPricePaise: x.requested_unit_paise,
      discountPaise: Math.max(0, (x.list_unit_paise - x.requested_unit_paise) * x.quantity),
      status: x.status,
      createdAt: x.created_at.toISOString(),
    }));
  }

  async decideApproval(id: string, approve: boolean, note: string | undefined, actor: string) {
    await inTransaction(this.db, async (tx) => {
      const a = await one<{ negotiation_id: string; requested_unit_paise: number; quantity: number; status: string }>(
        tx,
        sql`SELECT negotiation_id, requested_unit_paise, quantity, status FROM pricing_approvals WHERE id = ${id} FOR UPDATE`,
      );
      if (!a || a.status !== 'pending') throw new AppError('conflict', 'Approval not found or already decided');
      const s = await one<SessionRow>(tx, sql`SELECT * FROM negotiation_sessions WHERE id = ${a.negotiation_id} FOR UPDATE`);
      if (!s || s.state !== 'pending_approval') throw new AppError('conflict', 'Negotiation is no longer waiting for approval');
      if (approve) {
        // A human can approve a discount but never a price under the floor.
        const snap = await this.catalog.pricingSnapshot(s.variant_id, tx);
        if (a.requested_unit_paise < guardedFloor(snap.floorUnitPaise) && a.requested_unit_paise < s.list_unit_paise) {
          throw new AppError('conflict', 'The requested price is now below the price floor and cannot be approved');
        }
        const policy = await this.policy(s.band, tx);
        const quote = await this.issueQuote(tx, s, a.requested_unit_paise, a.quantity, policy.quoteTtlSeconds);
        await tx.execute(
          sql`UPDATE negotiation_sessions SET state = 'accepted', final_unit_paise = ${a.requested_unit_paise}, quantity = ${a.quantity},
                expires_at = ${quote.expiresAt}, updated_at = now() WHERE id = ${s.id}`,
        );
      } else {
        await tx.execute(sql`UPDATE negotiation_sessions SET state = 'rejected', updated_at = now() WHERE id = ${s.id}`);
      }
      await tx.execute(
        sql`UPDATE pricing_approvals SET status = ${approve ? 'approved' : 'declined'}, decided_by = ${actor}, note = ${note ?? null},
              decided_at = now() WHERE id = ${id}`,
      );
      await this.recordOffer(tx, s.id, 'seller', a.requested_unit_paise, a.quantity, approve ? 'accepted' : 'rejected', ['human_decision'], null);
      await appendEvent(tx, 'negotiation.closed', s.id, { negotiationId: s.id, outcome: approve ? 'accepted' : 'rejected', band: s.band, discountBps: 0 });
      await this.audit.record(tx, actor, approve ? 'pricing.approval_granted' : 'pricing.approval_declined', id, { negotiationId: s.id });
    });
    return (await this.listApprovals()).find((x) => x.id === id)!;
  }

  /** Latest quote token for a negotiation, for the buyer who owns it (chat and A2A flows). */
  async activeQuoteToken(subject: string, negotiationId: string): Promise<string | null> {
    const q = await one<{ id: string; negotiation_id: string; expires_at: Date }>(
      this.db,
      sql`SELECT q.id, q.negotiation_id, q.expires_at FROM quotes q JOIN negotiation_sessions n ON n.id = q.negotiation_id
          WHERE q.negotiation_id = ${negotiationId} AND n.subject = ${subject} AND q.status = 'active' AND q.expires_at > ${this.clock.now()}`,
    );
    if (!q) return null;
    return signToken(this.keys.quoteKey, 'quote', { qid: q.id, nid: q.negotiation_id, sub: subject, exp: Math.floor(q.expires_at.getTime() / 1000) });
  }

  async listForAdmin(limit: number, offset: number) {
    const sessions = await rows<SessionRow>(this.db, sql`SELECT * FROM negotiation_sessions ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`);
    if (!sessions.length) return [];
    const offers = await rows<{ negotiation_id: string; actor: 'buyer' | 'seller'; unit_price_paise: number; quantity: number; decision: string; created_at: Date }>(
      this.db,
      sql`SELECT negotiation_id, actor, unit_price_paise, quantity, decision, created_at FROM offers
          WHERE negotiation_id IN (${sql.join(sessions.map((s) => sql`${s.id}`), sql`, `)}) ORDER BY id`,
    );
    return sessions.map((s) => ({
      negotiationId: s.id,
      sku: s.sku,
      channel: s.channel,
      state: s.state,
      rounds: s.round,
      listUnitPricePaise: s.list_unit_paise,
      finalUnitPricePaise: s.final_unit_paise,
      createdAt: s.created_at.toISOString(),
      offers: offers
        .filter((o) => o.negotiation_id === s.id)
        .map((o) => ({ actor: o.actor, unitPricePaise: o.unit_price_paise, quantity: o.quantity, decision: o.decision, at: o.created_at.toISOString() })),
    }));
  }

  async listPolicies(): Promise<DiscountPolicyInput[]> {
    const r = await rows<PolicyRow>(this.db, sql`SELECT * FROM discount_policies ORDER BY band`);
    return r.map((p) => {
      const b = toPolicy(p);
      return { ...b, volumeTiers: [...b.volumeTiers] };
    });
  }

  async updatePolicy(input: DiscountPolicyInput, actor: string): Promise<DiscountPolicyInput> {
    const qtys = input.volumeTiers.map((t) => t.minQty);
    if (new Set(qtys).size !== qtys.length) throw new AppError('validation_failed', 'Volume tiers must have distinct minimum quantities');
    const tiers = [...input.volumeTiers].sort((a, b) => a.minQty - b.minQty);
    await inTransaction(this.db, async (tx) => {
      await tx.execute(
        sql`INSERT INTO discount_policies (band, negotiable_bps, volume_tiers, max_rounds, approval_threshold_paise, quote_ttl_seconds, concession_exponent)
            VALUES (${input.band}, ${input.negotiableBps}, ${json(tiers)}, ${input.maxRounds}, ${input.approvalThresholdPaise},
                    ${input.quoteTtlSeconds}, ${input.concessionExponent})
            ON CONFLICT (band) DO UPDATE SET negotiable_bps = EXCLUDED.negotiable_bps, volume_tiers = EXCLUDED.volume_tiers,
              max_rounds = EXCLUDED.max_rounds, approval_threshold_paise = EXCLUDED.approval_threshold_paise,
              quote_ttl_seconds = EXCLUDED.quote_ttl_seconds, concession_exponent = EXCLUDED.concession_exponent, updated_at = now()`,
      );
      await this.audit.record(tx, actor, 'pricing.policy_updated', input.band, { ...input, volumeTiers: tiers });
    });
    return { ...input, volumeTiers: tiers };
  }
}
