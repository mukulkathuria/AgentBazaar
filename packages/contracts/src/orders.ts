import { z } from 'zod';
import { Currency, GstStateCode, Paise, Quantity, Uuid } from './common.js';
import { CustomizationValues } from './customization.js';

export const OrderStatus = z.enum([
  'pending_payment',
  'payment_observed',
  'paid',
  'cod_confirmed',
  'shipped',
  'delivered',
  'return_requested',
  'returned',
  'refunded',
  'cancelled',
  'payment_failed',
  'expired',
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const PaymentMethod = z.enum(['online', 'cod']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const AddressInput = z.strictObject({
  name: z.string().trim().min(2).max(100),
  phone: z
    .string()
    .trim()
    .regex(/^(?:\+91[\s-]?)?[6-9]\d{9}$/, { error: 'Enter a valid Indian mobile number' }),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(80),
  stateCode: GstStateCode,
  pincode: z.string().regex(/^[1-9]\d{5}$/, { error: 'Enter a valid 6-digit PIN code' }),
});
export type AddressInput = z.infer<typeof AddressInput>;

export const CartLineInput = z.strictObject({
  sku: z.string().min(2).max(64),
  quantity: Quantity,
  customization: CustomizationValues.optional(),
});
export type CartLineInput = z.infer<typeof CartLineInput>;

export const CartLineView = z.object({
  lineId: Uuid,
  sku: z.string(),
  productName: z.string(),
  variantTitle: z.string(),
  quantity: Quantity,
  unitPricePaise: Paise,
  totalPaise: Paise,
  customization: CustomizationValues.nullable(),
  nonReturnable: z.boolean(),
});
export const CartView = z.object({
  cartId: Uuid,
  lines: z.array(CartLineView),
  subtotalPaise: Paise,
  currency: Currency,
});
export type CartView = z.infer<typeof CartView>;

export const StartCheckoutInput = z.union([
  z.strictObject({ cartId: Uuid }),
  z.strictObject({ quoteToken: z.string().min(20).max(2000) }),
]);
export type StartCheckoutInput = z.infer<typeof StartCheckoutInput>;

export const CheckoutLineView = z.object({
  sku: z.string(),
  productName: z.string(),
  quantity: Quantity,
  unitPricePaise: Paise,
  totalPaise: Paise,
  nonReturnable: z.boolean(),
  customization: CustomizationValues.nullable(),
});

export const CheckoutSessionView = z.object({
  sessionId: Uuid,
  status: z.enum(['open', 'completed', 'expired', 'cancelled']),
  lines: z.array(CheckoutLineView),
  subtotalPaise: Paise,
  currency: Currency,
  expiresAt: z.string(),
  source: z.enum(['cart', 'quote']),
  terms: z.array(z.string()),
  orderId: Uuid.nullable(),
});
export type CheckoutSessionView = z.infer<typeof CheckoutSessionView>;

export const CompleteCheckoutInput = z.strictObject({
  email: z.email().max(200),
  address: AddressInput,
  paymentMethod: PaymentMethod,
  acceptTerms: z.literal(true, { error: 'You must accept the terms of sale' }),
});
export type CompleteCheckoutInput = z.infer<typeof CompleteCheckoutInput>;

export const TaxLineView = z.object({
  kind: z.enum(['CGST', 'SGST', 'IGST']),
  rateBps: z.number().int(),
  amountPaise: Paise,
});

export const OrderLineView = z.object({
  sku: z.string(),
  productName: z.string(),
  quantity: Quantity,
  unitPricePaise: Paise,
  totalPaise: Paise,
  taxablePaise: Paise,
  taxes: z.array(TaxLineView),
  customization: CustomizationValues.nullable(),
  nonReturnable: z.boolean(),
});

export const OrderView = z.object({
  orderId: Uuid,
  number: z.string(),
  status: OrderStatus,
  paymentMethod: PaymentMethod,
  lines: z.array(OrderLineView),
  subtotalPaise: Paise,
  taxPaise: Paise,
  totalPaise: Paise,
  currency: Currency,
  placeOfSupply: GstStateCode,
  invoiceNumber: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  paymentUrl: z.string().nullable(),
  createdAt: z.string(),
  timeline: z.array(z.object({ status: OrderStatus, at: z.string(), note: z.string().nullable() })),
});
export type OrderView = z.infer<typeof OrderView>;

export const CheckoutLink = z.object({
  sessionId: Uuid,
  url: z.string(),
  expiresAt: z.string(),
  amountPaise: Paise,
  currency: Currency,
});
export type CheckoutLink = z.infer<typeof CheckoutLink>;

export const ReturnRequestInput = z.strictObject({
  reason: z.enum(['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other']),
  note: z.string().max(500).optional(),
});
export type ReturnRequestInput = z.infer<typeof ReturnRequestInput>;

export const ShipOrderInput = z.strictObject({ trackingNumber: z.string().trim().min(4).max(40) });
