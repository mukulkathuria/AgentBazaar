import type { NegotiationOutcome } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NegotiationService } from '../../src/modules/pricing/application/negotiation.service.js';
import { signToken } from '../../src/shared/crypto/keyring.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import { createShopApp, type ShopApp } from '../support/shop.js';

const KEYBOARD = 'THOCK-TK87-RED';
const GPU = 'ZENTRIX-ZX9090TI-24G';
const MUG = 'MITTI-MUG-WHITE';
const HOUR = 3_600_000;

/** Negotiation service against a seeded shop: the paths the HTTP suites do not reach. */
describe('@lite negotiation service', () => {
  let app: ShopApp;
  let clock: ManualClock;
  let svc: NegotiationService;
  let n = 0;
  const buyer = () => `anon:negotiation-${++n}`;
  const q = <T>(text: string, params: unknown[] = []) => app.infra.database.query<T>(text, params);
  const quote = (subject: string, sku = KEYBOARD, quantity = 1) => svc.requestQuote(subject, 'rest', { sku, quantity });
  const accept = (subject: string, token: string) => inTransaction(app.infra.db, (tx) => svc.acceptQuote(tx, subject, token));
  const session = async (id: string) =>
    (await q<{ state: string; round: number; current_ask_paise: number; final_unit_paise: number | null; quantity: number }>(
      'SELECT state, round, current_ask_paise, final_unit_paise, quantity FROM negotiation_sessions WHERE id = $1',
      [id],
    ))[0]!;
  const quoteStatuses = async (negotiationId: string) =>
    (await q<{ status: string }>('SELECT status FROM quotes WHERE negotiation_id = $1 ORDER BY created_at, id', [negotiationId])).map((r) => r.status);
  /** The signed claims of a quote token (the body is readable; only the signature is secret). */
  const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  /**
   * Premium GPU, two units: opening 99,000.00 (2-unit tier), lowest 96,030.00 after three rounds. Two lowballs,
   * then the round-3 ask: a 5,940 total discount, above the ₹3,000 approval threshold.
   */
  async function pendingApproval(subject: string): Promise<{ outcome: NegotiationOutcome; approvalId: string; previousToken: string }> {
    const opened = await quote(subject, GPU, 2);
    await svc.makeOffer(subject, opened.negotiationId, { unitPricePaise: 9_000_000 });
    const last = await svc.makeOffer(subject, opened.negotiationId, { unitPricePaise: 9_000_000 });
    const previousToken = last.quote!.token;
    const outcome = await svc.makeOffer(subject, opened.negotiationId, { unitPricePaise: 9_603_000 });
    const [row] = await q<{ id: string }>('SELECT id FROM pricing_approvals WHERE negotiation_id = $1', [opened.negotiationId]);
    return { outcome, approvalId: row!.id, previousToken };
  }

  beforeAll(async () => {
    clock = new ManualClock();
    app = await createShopApp({ clock });
    svc = app.app.get(NegotiationService);
  }, 120_000);
  afterAll(async () => app.close());

  it('opens with a signed quote, volume trades and a reply in the buyer language', async () => {
    const subject = buyer();
    const o = await svc.requestQuote(subject, 'mcp', { sku: KEYBOARD, quantity: 1 }, 'hi');
    expect(o).toMatchObject({ state: 'quote', decision: 'quoted', round: 0, roundsRemaining: 4, reasonCodes: ['opening'] });
    expect(o.quote).toMatchObject({ sku: KEYBOARD, quantity: 1, unitPricePaise: 549_900, totalPaise: 549_900, status: 'active', currency: 'INR' });
    expect(o.quote!.terms).toEqual([
      'Prices include GST.',
      `Single use; valid until ${o.quote!.expiresAt}.`,
      'Payment is confirmed by a person on the checkout page.',
    ]);
    expect(o.alternatives[0]).toMatchObject({ quantity: 3, reason: 'volume' });
    // The token is bound to this quote, negotiation and buyer, and expires with the quote.
    expect(claims(o.quote!.token)).toEqual({ qid: o.quote!.quoteId, nid: o.negotiationId, sub: subject, exp: epoch(o.quote!.expiresAt) });
    expect(o.message).toContain('प्रति पीस');
    const [offer] = await q<{ actor: string; decision: string; reason_codes: string[] }>(
      'SELECT actor, decision, reason_codes FROM offers WHERE negotiation_id = $1',
      [o.negotiationId],
    );
    expect(offer).toEqual({ actor: 'seller', decision: 'quoted', reason_codes: ['opening'] });
  });

  it('refuses unknown items, too many units and items without a pricing policy', async () => {
    await expect(quote(buyer(), 'NO-SUCH-SKU')).rejects.toMatchObject({ code: 'not_found' });
    await expect(quote(buyer(), GPU, 4)).rejects.toMatchObject({ code: 'out_of_stock', message: 'Only 3 available right now', details: { available: 3 } });
    const [fixed] = await q<Record<string, unknown>>(`SELECT * FROM discount_policies WHERE band = 'fixed'`);
    await q(`DELETE FROM discount_policies WHERE band = 'fixed'`);
    try {
      await expect(quote(buyer(), 'KOKOA-MINI-13G')).rejects.toMatchObject({ code: 'pricing_misconfigured', message: 'No discount policy for band fixed' });
    } finally {
      await q(
        `INSERT INTO discount_policies (band, negotiable_bps, volume_tiers, max_rounds, approval_threshold_paise, quote_ttl_seconds, concession_exponent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [fixed!.band, fixed!.negotiable_bps, JSON.stringify(fixed!.volume_tiers), fixed!.max_rounds, fixed!.approval_threshold_paise, fixed!.quote_ttl_seconds, fixed!.concession_exponent],
      );
    }
  });

  it('reports a cost above list as a pricing problem, not a crash', async () => {
    const [v] = await q<{ cost_price_paise: number }>(`SELECT cost_price_paise FROM variants WHERE sku = 'THOCK-TK87-BROWN'`);
    await q(`UPDATE variants SET cost_price_paise = 600000 WHERE sku = 'THOCK-TK87-BROWN'`);
    try {
      await expect(quote(buyer(), 'THOCK-TK87-BROWN')).rejects.toMatchObject({ code: 'pricing_misconfigured', message: 'This item cannot be quoted right now' });
    } finally {
      await q(`UPDATE variants SET cost_price_paise = $1 WHERE sku = 'THOCK-TK87-BROWN'`, [v!.cost_price_paise]);
    }
  });

  it('counters, redacts what the buyer wrote and hides other buyers negotiations', async () => {
    const subject = buyer();
    const o = await quote(subject);
    const c = await svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 440_000, message: 'call me on 9876543210' });
    expect(c).toMatchObject({ state: 'counter', decision: 'countered', round: 1, roundsRemaining: 3 });
    expect(c.quote!.unitPricePaise).toBe(547_200);
    expect(await session(o.negotiationId)).toMatchObject({ state: 'counter', round: 1, current_ask_paise: 547_200, final_unit_paise: null });
    expect(await quoteStatuses(o.negotiationId)).toEqual(['superseded', 'active']);
    const [said] = await q<{ message: string }>(`SELECT message FROM offers WHERE negotiation_id = $1 AND actor = 'buyer'`, [o.negotiationId]);
    expect(said!.message).toBe('call me on [PHONE]');
    await expect(svc.makeOffer(buyer(), o.negotiationId, { unitPricePaise: 540_000 })).rejects.toMatchObject({ code: 'not_found', message: 'Negotiation not found' });
    await expect(svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 1.5 })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('re-prices a changed quantity on its own ladder and checks stock for it', async () => {
    const subject = buyer();
    const o = await quote(subject);
    const more = await svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 400_000, quantity: 3 });
    expect(more.state).toBe('counter');
    // Three units open 2% lower, so the counter sits below the single-unit ladder's 547,200.
    expect(more.quote!.unitPricePaise).toBeLessThan(547_200);
    expect(more.quote!.quantity).toBe(3);
    expect((await session(o.negotiationId)).quantity).toBe(3);
    await expect(svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 400_000, quantity: 26 })).rejects.toMatchObject({ code: 'out_of_stock' });
  });

  it('closes a deal and turns its quote into a checkout exactly once', async () => {
    const subject = buyer();
    const o = await quote(subject);
    const deal = await svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 549_900 });
    expect(deal).toMatchObject({ state: 'accepted', decision: 'accepted', roundsRemaining: 4 });
    expect(await session(o.negotiationId)).toMatchObject({ state: 'accepted', final_unit_paise: 549_900 });
    const [closed] = await q<{ payload: { outcome: string; discountBps: number } }>(
      `SELECT payload FROM outbox_events WHERE topic = 'negotiation.closed' AND aggregate_id = $1`,
      [o.negotiationId],
    );
    expect(closed!.payload).toMatchObject({ outcome: 'accepted', discountBps: 0 });
    await expect(svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 500_000 })).rejects.toMatchObject({
      code: 'negotiation_closed',
      message: 'This negotiation is accepted; no more offers',
    });

    await expect(accept(buyer(), deal.quote!.token)).rejects.toMatchObject({ code: 'quote_invalid', message: 'This quote was issued to someone else' });
    const accepted = await accept(subject, deal.quote!.token);
    expect(accepted).toMatchObject({ negotiationId: o.negotiationId, sku: KEYBOARD, quantity: 1, unitPricePaise: 549_900, listUnitPaise: 549_900, customization: null });
    expect(await session(o.negotiationId)).toMatchObject({ state: 'checkout' });
    await expect(accept(subject, deal.quote!.token)).rejects.toMatchObject({ code: 'quote_used', message: 'This quote has already been used' });
  });

  it('tells apart forged, expired, superseded and withdrawn quotes', async () => {
    const subject = buyer();
    await expect(accept(subject, 'not-a-token')).rejects.toMatchObject({ code: 'quote_invalid', message: 'This quote is not valid' });
    const o = await quote(subject);
    const first = o.quote!.token;
    const forged = signToken(Buffer.alloc(32, 1), 'quote', { qid: o.quote!.quoteId, nid: o.negotiationId, sub: subject, exp: 4_102_444_800 });
    await expect(accept(subject, forged)).rejects.toMatchObject({ code: 'quote_invalid' });

    const counter = await svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 440_000 });
    await expect(accept(subject, first)).rejects.toMatchObject({ code: 'quote_invalid', message: 'A newer quote replaced this one' });

    await q(`UPDATE quotes SET status = 'expired' WHERE id = $1`, [counter.quote!.quoteId]);
    await expect(accept(subject, counter.quote!.token)).rejects.toMatchObject({ code: 'quote_expired', message: 'This quote has expired. Ask for a new one.' });
    // A validly signed token whose quote row is gone (a retention purge) reads as expired, not as a crash.
    const purged = await quote(subject);
    await q('DELETE FROM quotes WHERE id = $1', [purged.quote!.quoteId]);
    await expect(accept(subject, purged.quote!.token)).rejects.toMatchObject({ code: 'quote_expired', message: 'This quote has expired. Ask for a new one.' });

    const other = await quote(subject);
    clock.advance(16 * 60_000);
    try {
      await expect(accept(subject, other.quote!.token)).rejects.toMatchObject({ code: 'quote_expired', message: 'This quote has expired. Ask for a new one.' });
      expect(await svc.activeQuoteToken(subject, other.negotiationId)).toBeNull();
    } finally {
      await svc.sweepExpired();
    }
  });

  it('expires a stale negotiation on the next offer and keeps it closed', async () => {
    const subject = buyer();
    const o = await quote(subject);
    const reissued = await svc.activeQuoteToken(subject, o.negotiationId);
    expect(claims(reissued!)).toEqual({ qid: o.quote!.quoteId, nid: o.negotiationId, sub: subject, exp: epoch(o.quote!.expiresAt) });
    expect(await svc.activeQuoteToken(buyer(), o.negotiationId)).toBeNull();
    clock.advance(15 * 60_000);
    await expect(svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 540_000 })).rejects.toMatchObject({
      code: 'quote_expired',
      message: 'This negotiation has expired. Request a new quote.',
    });
    expect(await session(o.negotiationId)).toMatchObject({ state: 'expired' });
    expect(await quoteStatuses(o.negotiationId)).toEqual(['expired']);
    await expect(svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 540_000 })).rejects.toMatchObject({
      code: 'negotiation_closed',
      message: 'This negotiation is expired; no more offers',
    });
  });

  it('sweeps negotiations and quotes whose time is up, and only those', async () => {
    const subject = buyer();
    const stale = await quote(subject);
    clock.advance(10 * 60_000);
    const fresh = await quote(subject);
    clock.advance(5 * 60_000);
    expect(await svc.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await session(stale.negotiationId)).toMatchObject({ state: 'expired' });
    expect(await quoteStatuses(stale.negotiationId)).toEqual(['expired']);
    expect(await session(fresh.negotiationId)).toMatchObject({ state: 'quote' });
    expect(await svc.sweepExpired(app.infra.db)).toBe(0);
  });

  it('quotes a personalised item with its surcharge and only ever at a fixed price', async () => {
    const subject = buyer();
    const o = await svc.requestQuote(subject, 'chat', { sku: MUG, quantity: 1, customization: { text: { name: '  Asha ' } } });
    expect(o.quote!.unitPricePaise).toBe(44_900 + 9_900);
    expect(o.quote!.terms).toContain('Personalised items are non-returnable.');
    const [row] = await q<{ customization: Record<string, string> }>('SELECT customization FROM quotes WHERE id = $1', [o.quote!.quoteId]);
    expect(row!.customization).toEqual({ text: { name: 'Asha' } });
    const r = await svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 40_000 });
    expect(r).toMatchObject({ state: 'rejected', decision: 'rejected', reasonCodes: ['fixed_price'] });
    expect(r.quote!.unitPricePaise).toBe(54_800);
    const accepted = await accept(subject, r.quote!.token);
    expect(accepted.customization).toEqual({ text: { name: 'Asha' } });
  });

  it('asks a human for a big discount; the earlier quote cannot be used meanwhile', async () => {
    const subject = buyer();
    const { outcome, approvalId, previousToken } = await pendingApproval(subject);
    expect(outcome).toMatchObject({ state: 'pending_approval', decision: 'pending_approval', quote: null, reasonCodes: ['within_policy', 'needs_human_approval'] });
    const s = await session(outcome.negotiationId);
    // The ask stays where it was while a manager decides.
    expect(s).toMatchObject({ state: 'pending_approval', round: 3, final_unit_paise: null });
    expect(s.current_ask_paise).toBeGreaterThan(9_603_000);
    await expect(accept(subject, previousToken)).rejects.toMatchObject({ code: 'negotiation_closed', message: 'This negotiation is pending_approval' });

    const pending = (await svc.listApprovals()).find((a) => a.id === approvalId)!;
    expect(pending).toMatchObject({ negotiationId: outcome.negotiationId, sku: GPU, quantity: 2, status: 'pending', requestedUnitPricePaise: 9_603_000 });
    expect(pending.discountPaise).toBe((pending.listUnitPricePaise - 9_603_000) * 2);
  });

  it('lets an admin approve: the buyer gets a quote at the approved price, and it is audited', async () => {
    const subject = buyer();
    const { outcome, approvalId } = await pendingApproval(subject);
    const decided = await svc.decideApproval(approvalId, true, 'loyal customer', 'admin:1');
    expect(decided).toMatchObject({ id: approvalId, status: 'approved' });
    expect(await session(outcome.negotiationId)).toMatchObject({ state: 'accepted', final_unit_paise: 9_603_000, quantity: 2 });
    const token = await svc.activeQuoteToken(subject, outcome.negotiationId);
    expect((await accept(subject, token!)).unitPricePaise).toBe(9_603_000);
    const [audit] = await q<{ actor: string; action: string }>(`SELECT actor, action FROM audit_log WHERE target = $1`, [approvalId]);
    expect(audit).toEqual({ actor: 'admin:1', action: 'pricing.approval_granted' });
    const [approval] = await q<{ decided_by: string; note: string }>('SELECT decided_by, note FROM pricing_approvals WHERE id = $1', [approvalId]);
    expect(approval).toEqual({ decided_by: 'admin:1', note: 'loyal customer' });
    await expect(svc.decideApproval(approvalId, true, undefined, 'admin:1')).rejects.toMatchObject({
      code: 'conflict',
      message: 'Approval not found or already decided',
    });
  });

  it('lets an admin decline, and refuses approvals that went stale or now sit under the floor', async () => {
    const declined = await pendingApproval(buyer());
    expect(await svc.decideApproval(declined.approvalId, false, undefined, 'admin:2')).toMatchObject({ status: 'declined' });
    expect(await session(declined.outcome.negotiationId)).toMatchObject({ state: 'rejected' });
    const [audit] = await q<{ action: string }>(`SELECT action FROM audit_log WHERE target = $1`, [declined.approvalId]);
    expect(audit!.action).toBe('pricing.approval_declined');
    await expect(svc.decideApproval('00000000-0000-4000-8000-000000000000', true, undefined, 'admin:2')).rejects.toMatchObject({ code: 'conflict' });

    const stale = await pendingApproval(buyer());
    await q(`UPDATE negotiation_sessions SET state = 'expired' WHERE id = $1`, [stale.outcome.negotiationId]);
    await expect(svc.decideApproval(stale.approvalId, true, undefined, 'admin:2')).rejects.toMatchObject({
      code: 'conflict',
      message: 'Negotiation is no longer waiting for approval',
    });

    const underFloor = await pendingApproval(buyer());
    const [v] = await q<{ cost_price_paise: number }>('SELECT cost_price_paise FROM variants WHERE sku = $1', [GPU]);
    await q('UPDATE variants SET cost_price_paise = 9000000 WHERE sku = $1', [GPU]);
    try {
      await expect(svc.decideApproval(underFloor.approvalId, true, undefined, 'admin:2')).rejects.toMatchObject({
        code: 'conflict',
        message: 'The requested price is now below the price floor and cannot be approved',
      });
    } finally {
      await q('UPDATE variants SET cost_price_paise = $1 WHERE sku = $2', [v!.cost_price_paise, GPU]);
    }
  });

  it('declines pending approvals when their window closes', async () => {
    const { outcome, approvalId } = await pendingApproval(buyer());
    clock.advance(24 * HOUR);
    expect(await svc.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await session(outcome.negotiationId)).toMatchObject({ state: 'expired' });
    const [a] = await q<{ status: string; note: string }>('SELECT status, note FROM pricing_approvals WHERE id = $1', [approvalId]);
    expect(a).toEqual({ status: 'declined', note: 'expired' });
  });

  it('lists negotiations with their turns for admins, newest first', async () => {
    const subject = buyer();
    const o = await quote(subject);
    await svc.makeOffer(subject, o.negotiationId, { unitPricePaise: 440_000 });
    const page = await svc.listForAdmin(500, 0);
    const mine = page.find((x) => x.negotiationId === o.negotiationId)!;
    expect(mine).toMatchObject({ sku: KEYBOARD, channel: 'rest', state: 'counter', rounds: 1, listUnitPricePaise: 549_900, finalUnitPricePaise: null });
    expect(mine.offers.map((x) => [x.actor, x.decision, x.unitPricePaise])).toEqual([
      ['seller', 'quoted', 549_900],
      ['buyer', 'offer', 440_000],
      ['seller', 'countered', 547_200],
    ]);
    expect(await svc.listForAdmin(10, 100_000)).toEqual([]);
  });

  it('edits band policies: sorted tiers, distinct minimums, every change audited', async () => {
    const before = await svc.listPolicies();
    expect(before.map((p) => p.band)).toEqual(['fixed', 'premium', 'standard']);
    const standard = before.find((p) => p.band === 'standard')!;
    await expect(
      svc.updatePolicy({ ...standard, volumeTiers: [{ minQty: 3, extraBps: 100 }, { minQty: 3, extraBps: 200 }] }, 'admin:3'),
    ).rejects.toMatchObject({ code: 'validation_failed', message: 'Volume tiers must have distinct minimum quantities' });
    try {
      const saved = await svc.updatePolicy({ ...standard, maxRounds: 2, volumeTiers: [{ minQty: 10, extraBps: 700 }, { minQty: 3, extraBps: 200 }] }, 'admin:3');
      expect(saved.volumeTiers).toEqual([{ minQty: 3, extraBps: 200 }, { minQty: 10, extraBps: 700 }]);
      expect((await svc.policy('standard')).maxRounds).toBe(2);
      const [audit] = await q<{ actor: string; target: string }>(`SELECT actor, target FROM audit_log WHERE action = 'pricing.policy_updated'`);
      expect(audit).toEqual({ actor: 'admin:3', target: 'standard' });
    } finally {
      await svc.updatePolicy(standard, 'admin:3');
    }
    expect(await svc.listPolicies()).toEqual(before);
  });
});
