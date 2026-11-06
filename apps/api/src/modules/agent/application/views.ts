import {
  type A2ACheckout,
  type A2AQuote,
  type Availability,
  type CheckoutLink,
  type CheckoutSessionView,
  type CustomizationOptions,
  type CustomizationValidation,
  type NegotiationOutcome,
  type OrderView,
  type ProductSummary,
  type PublicProduct,
  toMoneyDto,
} from '@agentbazaar/contracts';
import type { z } from 'zod';
import { AppError } from '../../../shared/kernel/errors.js';

/** Errors agents may see: expected failures keep their (user-facing) message, anything else is generic. */
export function publicError(err: unknown): { code: string; message: string } {
  if (err instanceof AppError && err.status < 500) return { code: err.code, message: err.message };
  if (err instanceof AppError) return { code: err.code, message: 'This is temporarily unavailable. Please try again shortly.' };
  if (err instanceof RangeError) return { code: 'validation_failed', message: err.message };
  return { code: 'internal', message: 'Something went wrong. Please try again.' };
}

/** Unexpected failures worth logging (not validation or business-rule refusals). */
export const isUnexpected = (err: unknown): boolean => !(err instanceof AppError && err.status < 500) && !(err instanceof RangeError);

/**
 * What agents see. Built field by field from public service results, so nothing else (floors,
 * costs, other buyers' data, capability tokens) can leak through a spread. Money is in rupees.
 */
const inr = (paise: number): number => paise / 100;

export const productSummaryView = (p: ProductSummary) => ({
  name: p.name,
  slug: p.slug,
  sku: p.defaultSku,
  brand: p.brand,
  category: p.categoryPath,
  price_inr: inr(p.minPricePaise),
  max_price_inr: inr(p.maxPricePaise),
  price_band: p.band,
  in_stock: p.inStock,
  customizable: p.customizable,
});

export const productView = (p: PublicProduct) => ({
  name: p.name,
  slug: p.slug,
  brand: p.brand,
  description: p.description,
  category: p.category.path,
  price_band: p.band,
  customizable: p.customizable,
  returnable: p.returnable,
  return_window_days: p.returnWindowDays,
  attributes: p.attributes,
  rating: p.rating,
  faqs: p.faqs,
  variants: p.variants.map((v) => ({
    sku: v.sku,
    title: v.title,
    options: v.options,
    price_inr: inr(v.pricePaise),
    mrp_inr: inr(v.mrpPaise),
    in_stock: v.inStock,
    available_qty: v.availableQty,
  })),
});

export const availabilityView = (a: Availability) => ({
  sku: a.sku,
  in_stock: a.inStock,
  available_qty: a.availableQty,
  can_fulfil_quantity: a.canFulfilQuantity,
  requested_quantity: a.requestedQuantity,
});

export const customizationOptionsView = (o: CustomizationOptions) => ({
  fields: o.fields.map((f) => ({
    key: f.key,
    label: f.label,
    min_length: f.minLength,
    max_length: f.maxLength,
    script: f.script,
    required: f.required,
    emoji_allowed: f.allowEmoji,
  })),
  designs: o.designs.map((d) => ({ id: d.id, name: d.name })),
  design_required: o.designRequired,
  surcharge_inr: inr(o.surchargePaise),
  non_returnable: o.nonReturnable,
  notice: o.notice,
});

export const validationView = (v: CustomizationValidation) => ({
  verdict: v.verdict,
  issues: v.issues.map((i) => ({ field: i.field, code: i.code, message: i.message })),
  normalized: v.normalized,
  surcharge_inr: inr(v.surchargePaise),
  preview_url: v.previewUrl,
});

export const negotiationView = (o: NegotiationOutcome) => ({
  negotiation_id: o.negotiationId,
  state: o.state,
  decision: o.decision,
  round: o.round,
  rounds_remaining: o.roundsRemaining,
  final_offer: o.reasonCodes.includes('final_offer') || o.roundsRemaining === 0,
  message: o.message,
  quote: o.quote && {
    quote_token: o.quote.token,
    sku: o.quote.sku,
    product_name: o.quote.productName,
    quantity: o.quote.quantity,
    unit_price_inr: inr(o.quote.unitPricePaise),
    list_unit_price_inr: inr(o.quote.listUnitPricePaise),
    total_inr: inr(o.quote.totalPaise),
    valid_until: o.quote.expiresAt,
    terms: o.quote.terms,
  },
  alternatives: o.alternatives.map((a) => ({ quantity: a.quantity, unit_price_inr: inr(a.unitPricePaise) })),
});

export const checkoutSessionView = (s: CheckoutSessionView) => ({
  checkout_session_id: s.sessionId,
  status: s.status,
  lines: s.lines.map((l) => ({
    sku: l.sku,
    product_name: l.productName,
    quantity: l.quantity,
    unit_price_inr: inr(l.unitPricePaise),
    total_inr: inr(l.totalPaise),
    non_returnable: l.nonReturnable,
  })),
  subtotal_inr: inr(s.subtotalPaise),
  expires_at: s.expiresAt,
  terms: s.terms,
  next_step: 'Call create_checkout_link with this checkout_session_id to get the link a person opens to pay.',
});

export const checkoutLinkView = (l: CheckoutLink) => ({
  checkout_session_id: l.sessionId,
  checkout_url: l.url,
  valid_until: l.expiresAt,
  amount_inr: inr(l.amountPaise),
  note: 'A person must open this link to confirm the delivery address and pay. Agents cannot complete payment.',
});

export const orderView = (o: OrderView) => ({
  order_id: o.orderId,
  number: o.number,
  status: o.status,
  total_inr: inr(o.totalPaise),
  lines: o.lines.map((l) => ({ sku: l.sku, product_name: l.productName, quantity: l.quantity, unit_price_inr: inr(l.unitPricePaise) })),
  tracking_number: o.trackingNumber,
  created_at: o.createdAt,
  timeline: o.timeline.map((t) => ({ status: t.status, at: t.at })),
});

/** What the buyer agent offered, for outcomes that carry no quote (a discount waiting for approval). */
export interface OfferHint {
  sku?: string;
  quantity?: number;
  unitPaise?: number;
}

export function toA2AQuote(o: NegotiationOutcome, hint: OfferHint = {}): z.infer<typeof A2AQuote> {
  const q = o.quote;
  const quantity = q?.quantity ?? hint.quantity ?? 1;
  const unit = q?.unitPricePaise ?? hint.unitPaise ?? 0;
  return {
    type: 'quote',
    negotiation_id: o.negotiationId,
    state: o.state,
    decision: o.decision,
    sku: q?.sku ?? hint.sku ?? '',
    quantity,
    unit_price: toMoneyDto(unit),
    total: toMoneyDto(unit * quantity),
    quote_token: q?.token ?? null,
    valid_until: q?.expiresAt ?? null,
    rounds_remaining: o.roundsRemaining,
    alternatives: o.alternatives.map((a) => ({ quantity: a.quantity, unit_price: toMoneyDto(a.unitPricePaise) })),
  };
}

export const toA2ACheckout = (l: CheckoutLink): z.infer<typeof A2ACheckout> => ({
  type: 'checkout',
  checkout_session_id: l.sessionId,
  checkout_url: l.url,
  valid_until: l.expiresAt,
  amount: toMoneyDto(l.amountPaise),
});
