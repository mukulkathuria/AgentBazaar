import type { CustomizationValues, QuoteView } from '@agentbazaar/contracts';

/** A quote as buyers and agents see it. */
export function quoteView(
  s: { id: string; sku: string; product_name: string; list_unit_paise: number; customization: CustomizationValues | null },
  q: { quoteId: string; token: string; expiresAt: Date; unit: number; quantity: number },
): QuoteView {
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
