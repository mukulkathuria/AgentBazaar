import { z } from 'zod';
import { Quantity, Uuid } from './common.js';
import { MoneyDto } from './money.js';
import type { AgentScope } from './identity.js';

/**
 * MCP tool inputs. snake_case and rupee amounts because LLM callers handle them more reliably
 * than camelCase paise. No transforms here so JSON Schema generation stays exact; handlers
 * convert rupees to paise with rupeesToPaise().
 */
const SkuArg = z.string().min(2).max(64).describe('Variant SKU, e.g. "GPU-RTX5070-12G"');
const Inr = z.number().min(0).max(10_000_000).describe('Amount in Indian rupees, up to 2 decimals');

export const McpToolInputs = {
  search_products: z.object({
    query: z.string().max(200).default('').describe('Keywords, e.g. "gpu 12gb" or "dark chocolate"'),
    category: z.string().max(200).optional().describe('Category path, e.g. "electronics.gpus"'),
    max_price_inr: Inr.optional(),
    min_price_inr: Inr.optional(),
    in_stock_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  get_product: z.object({ slug_or_sku: z.string().min(2).max(160) }),
  check_availability: z.object({ sku: SkuArg, quantity: Quantity.default(1) }),
  get_customization_options: z.object({ sku: SkuArg }),
  validate_customization: z.object({
    sku: SkuArg,
    text: z.record(z.string().max(40), z.string().max(500)).default({}),
    design_id: Uuid.optional(),
  }),
  get_recommendations: z.object({ sku: SkuArg, limit: z.number().int().min(1).max(10).default(5) }),
  get_compatible_items: z.object({ sku: SkuArg, limit: z.number().int().min(1).max(10).default(5) }),
  request_quote: z.object({
    sku: SkuArg,
    quantity: Quantity,
    customization_text: z.record(z.string().max(40), z.string().max(500)).optional(),
    design_id: Uuid.optional(),
  }),
  make_offer: z.object({
    negotiation_id: Uuid,
    unit_price_inr: Inr.describe('Your offered price per unit in rupees'),
    quantity: Quantity.optional().describe('Change quantity, e.g. to unlock a volume price'),
    message: z.string().max(1000).optional(),
  }),
  accept_quote: z.object({ quote_token: z.string().min(20).max(2000) }),
  create_checkout_link: z.object({ checkout_session_id: Uuid }),
  get_order_status: z.object({ order_id: Uuid }),
} as const;

export type McpToolName = keyof typeof McpToolInputs;

export const MCP_TOOL_SCOPES: Record<McpToolName, AgentScope> = {
  search_products: 'catalog:read',
  get_product: 'catalog:read',
  check_availability: 'catalog:read',
  get_customization_options: 'catalog:read',
  validate_customization: 'catalog:read',
  get_recommendations: 'catalog:read',
  get_compatible_items: 'catalog:read',
  request_quote: 'quote:create',
  make_offer: 'quote:create',
  accept_quote: 'order:create',
  create_checkout_link: 'order:create',
  get_order_status: 'order:create',
};

/** A2A structured parts (DataPart.data). Same negotiation state machine as MCP. */
export const A2AQuoteRequest = z.object({
  type: z.literal('quote_request'),
  sku: SkuArg,
  quantity: Quantity,
});
export const A2AOffer = z.object({
  type: z.literal('offer'),
  negotiation_id: Uuid,
  quantity: Quantity.optional(),
  unit_price: MoneyDto,
  valid_until: z.string().optional(),
});
export const A2AAccept = z.object({ type: z.literal('accept'), quote_token: z.string().min(20).max(2000) });
export const A2AInbound = z.discriminatedUnion('type', [A2AQuoteRequest, A2AOffer, A2AAccept]);
export type A2AInbound = z.infer<typeof A2AInbound>;

export const A2AQuote = z.object({
  type: z.literal('quote'),
  negotiation_id: Uuid,
  state: z.string(),
  decision: z.string(),
  sku: z.string(),
  quantity: Quantity,
  unit_price: MoneyDto,
  total: MoneyDto,
  quote_token: z.string().nullable(),
  valid_until: z.string().nullable(),
  rounds_remaining: z.number().int(),
  alternatives: z.array(z.object({ quantity: Quantity, unit_price: MoneyDto })),
});
export const A2ACheckout = z.object({
  type: z.literal('checkout'),
  checkout_session_id: Uuid,
  checkout_url: z.string(),
  valid_until: z.string(),
  amount: MoneyDto,
});
