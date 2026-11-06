import type { PriceBand, TradeAlternative } from '@agentbazaar/contracts';

export interface VolumeTier {
  minQty: number;
  extraBps: number;
}

/** Per-band negotiation policy, editable by admins. Numbers only ever come from here and the catalog. */
export interface BandPolicy {
  band: PriceBand;
  negotiableBps: number;
  volumeTiers: readonly VolumeTier[];
  maxRounds: number;
  approvalThresholdPaise: number | null;
  quoteTtlSeconds: number;
  concessionExponent: number;
}

export class PricingMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingMisconfiguredError';
  }
}

export interface LadderInput {
  /** List unit price including any customization surcharge. */
  listUnitPaise: number;
  /** Hard floor: landed cost plus minimum margin. Secret. */
  floorUnitPaise: number;
  quantity: number;
  customized: boolean;
}

/** The seller's price ladder for one negotiation: opening ask down to the lowest acceptable price. */
export interface Ladder {
  openingUnit: number;
  minUnit: number;
  maxRounds: number;
  exponent: number;
}

const ceilRupee = (paise: number): number => Math.ceil(paise / 100) * 100;
const lessBps = (paise: number, bps: number): number => (paise * (10_000 - bps)) / 10_000;

/** Published quantity discount for this quantity (largest tier reached). */
export function volumeBps(tiers: readonly VolumeTier[], quantity: number): number {
  let best = 0;
  for (const t of tiers) if (quantity >= t.minQty) best = Math.max(best, t.extraBps);
  return best;
}

/**
 * Lowest price we may ever show below list: strictly above the floor (by at least ₹1 or 0.5%) and
 * rounded up to a whole rupee, so no quote ever equals, or reveals, the floor.
 */
export function guardedFloor(floorUnitPaise: number): number {
  return ceilRupee(floorUnitPaise + Math.max(100, Math.ceil(floorUnitPaise * 0.005)));
}

export function computeLadder(policy: BandPolicy, input: LadderInput): Ladder {
  const list = input.listUnitPaise;
  if (!Number.isInteger(list) || list <= 0) throw new PricingMisconfiguredError('List price must be a positive integer');
  if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new RangeError('Quantity must be at least 1');
  if (input.floorUnitPaise > list) throw new PricingMisconfiguredError('Floor price is above the list price');
  const flat: Ladder = { openingUnit: list, minUnit: list, maxRounds: 0, exponent: policy.concessionExponent };
  const guard = guardedFloor(input.floorUnitPaise);
  if (guard >= list) return flat;
  const vBps = volumeBps(policy.volumeTiers, input.quantity);
  const opening = vBps > 0 ? Math.min(list, Math.max(guard, ceilRupee(lessBps(list, vBps)))) : list;
  // Customized items get quantity discounts only.
  const negotiable = input.customized ? 0 : policy.negotiableBps;
  const min = negotiable > 0 ? Math.min(opening, Math.max(guard, ceilRupee(lessBps(opening, negotiable)))) : opening;
  return { openingUnit: opening, minUnit: min, maxRounds: min < opening ? policy.maxRounds : 0, exponent: policy.concessionExponent };
}

/** Seller's ask after `round` buyer offers. Boulware curve: concede little early, more near the end. */
export function askAt(ladder: Ladder, round: number): number {
  if (ladder.maxRounds === 0 || ladder.minUnit >= ladder.openingUnit) return ladder.openingUnit;
  const r = Math.min(Math.max(round, 0), ladder.maxRounds);
  const conceded = (r / ladder.maxRounds) ** ladder.exponent;
  const raw = ladder.minUnit + (ladder.openingUnit - ladder.minUnit) * (1 - conceded);
  return Math.min(ladder.openingUnit, Math.max(ladder.minUnit, ceilRupee(raw)));
}

export interface Position {
  round: number;
  currentAskUnit: number;
  quantity: number;
}

export type DecisionKind = 'accept' | 'counter' | 'reject' | 'approval';

export interface OfferDecision {
  kind: DecisionKind;
  /** Unit price of the quote issued with this decision. */
  unitPaise: number;
  round: number;
  final: boolean;
  reasonCodes: string[];
}

function withApproval(policy: BandPolicy, ladder: Ladder, quantity: number, d: OfferDecision): OfferDecision {
  const threshold = policy.approvalThresholdPaise;
  if (threshold === null) return d;
  const discount = (ladder.openingUnit - d.unitPaise) * quantity;
  return discount > threshold ? { ...d, kind: 'approval', reasonCodes: [...d.reasonCodes, 'needs_human_approval'] } : d;
}

/**
 * Pure decision for one buyer offer. Every possible outcome prices at or above the ladder minimum,
 * which is strictly above the floor, so no sequence of offers can buy below the floor.
 */
export function decideOffer(policy: BandPolicy, ladder: Ladder, pos: Position, offerUnit: number): OfferDecision {
  if (!Number.isInteger(offerUnit) || offerUnit <= 0) throw new RangeError('Offer must be a positive amount in paise');
  if (offerUnit >= pos.currentAskUnit) {
    return withApproval(policy, ladder, pos.quantity, {
      kind: 'accept',
      unitPaise: pos.currentAskUnit,
      round: pos.round,
      final: true,
      reasonCodes: ['offer_meets_ask'],
    });
  }
  if (ladder.maxRounds === 0) {
    return { kind: 'reject', unitPaise: pos.currentAskUnit, round: pos.round, final: true, reasonCodes: ['fixed_price'] };
  }
  if (pos.round >= ladder.maxRounds) {
    return { kind: 'reject', unitPaise: pos.currentAskUnit, round: pos.round, final: true, reasonCodes: ['rounds_exhausted'] };
  }
  const next = pos.round + 1;
  const nextAsk = Math.min(pos.currentAskUnit, askAt(ladder, next));
  if (offerUnit >= nextAsk) {
    return withApproval(policy, ladder, pos.quantity, { kind: 'accept', unitPaise: offerUnit, round: next, final: true, reasonCodes: ['within_policy'] });
  }
  const reasons = offerUnit < ladder.minUnit * 0.6 ? ['lowball'] : [];
  const final = next >= ladder.maxRounds;
  return { kind: 'counter', unitPaise: nextAsk, round: next, final, reasonCodes: [...reasons, final ? 'final_offer' : 'counter'] };
}

/** "Trade instead of give": what larger quantities would cost per unit at this round. */
export function volumeAlternatives(
  policy: BandPolicy,
  input: LadderInput,
  round: number,
  currentUnit: number,
  max = 2,
): TradeAlternative[] {
  const out: TradeAlternative[] = [];
  const tiers = [...policy.volumeTiers].filter((t) => t.minQty > input.quantity).sort((a, b) => a.minQty - b.minQty);
  for (const t of tiers) {
    if (out.length >= max || t.minQty > 1000) break;
    const unit = askAt(computeLadder(policy, { ...input, quantity: t.minQty }), round);
    if (unit < currentUnit) out.push({ quantity: t.minQty, unitPricePaise: unit, reason: 'volume' });
  }
  return out;
}
