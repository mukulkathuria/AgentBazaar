import type { CustomizationValues } from '@agentbazaar/contracts';
import type { VariantRef } from '../../catalog/index.js';
import type { CheckedCustomization } from '../../customization/index.js';

/** A line whose price is fixed for the life of a checkout session (stored as JSON on the session). */
export interface LockedLine {
  variantId: string;
  sku: string;
  productName: string;
  variantTitle: string;
  hsnCode: string;
  quantity: number;
  unitPricePaise: number;
  totalPaise: number;
  /** Return policy at the time of sale. */
  returnWindowDays: number;
  nonReturnable: boolean;
  customization: CustomizationValues | null;
  /** Customization text a person must review before production. */
  flagged: CheckedCustomization['flagged'];
}

export function lockLine(
  v: VariantRef,
  quantity: number,
  unitPricePaise: number,
  customization: CustomizationValues | null,
  flagged: CheckedCustomization['flagged'],
): LockedLine {
  return {
    variantId: v.variantId,
    sku: v.sku,
    productName: v.productName,
    variantTitle: v.title,
    hsnCode: v.hsnCode,
    quantity,
    unitPricePaise,
    totalPaise: unitPricePaise * quantity,
    returnWindowDays: v.returnWindowDays,
    // Personalised items are made to order, so they are never returnable.
    nonReturnable: v.returnWindowDays === 0 || customization !== null,
    customization,
    flagged,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids from MCP/A2A callers are not schema-validated; a malformed one must read as "not found", not a 500. */
export const isUuid = (s: string): boolean => UUID.test(s);
