import { bandForPrice, type AttributeDef, type PriceBand } from '@agentbazaar/contracts';

export interface LandedCost {
  freight?: number;
  paymentFee?: number;
  expectedReturnCost?: number;
  nonRecoverableTax?: number;
}

/**
 * Hard per-unit floor = landed cost x (1 + minimum margin), rounded up to the paisa.
 * Landed cost = purchase cost + freight + payment fee + expected return cost + non-recoverable tax.
 */
export function floorPaise(costPricePaise: number, landed: LandedCost, minMarginBps: number): number {
  const landedTotal =
    costPricePaise + (landed.freight ?? 0) + (landed.paymentFee ?? 0) + (landed.expectedReturnCost ?? 0) + (landed.nonRecoverableTax ?? 0);
  return Math.ceil((landedTotal * (10_000 + minMarginBps)) / 10_000);
}

/** The product's band follows its highest-priced variant, so premium rules apply when in doubt. */
export function productBand(variantPrices: readonly number[]): PriceBand {
  return bandForPrice(Math.max(...variantPrices));
}

export type AttributeValue = string | number | boolean;

function typeMatches(d: AttributeDef, value: AttributeValue): boolean {
  switch (d.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && (d.values ?? []).includes(value);
  }
}

/** Validates JSONB attributes against the category's attribute schema. Returns problems found. */
export function validateAttributes(defs: readonly AttributeDef[], attrs: Record<string, AttributeValue>): string[] {
  const problems: string[] = [];
  const known = new Map(defs.map((d) => [d.key, d]));
  for (const d of defs) {
    if (d.required && attrs[d.key] === undefined) problems.push(`${d.key} is required`);
  }
  for (const [key, value] of Object.entries(attrs)) {
    const d = known.get(key);
    if (!d) {
      if (defs.length) problems.push(`${key} is not an attribute of this category`);
      continue;
    }
    const ok = typeMatches(d, value);
    if (!ok) problems.push(`${key} must be ${d.type === 'enum' ? `one of ${(d.values ?? []).join(', ')}` : `a ${d.type}`}`);
  }
  return problems;
}
