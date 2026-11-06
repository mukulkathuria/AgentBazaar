import { Inject, Injectable } from '@nestjs/common';
import { MCP_TOOL_SCOPES, type McpToolInputs, type McpToolName, rupeesToPaise } from '@agentbazaar/contracts';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Cache } from '../../../shared/cache/cache.js';
import { sha256Hex } from '../../../shared/crypto/primitives.js';
import { assertRequirement, type Principal } from '../../../shared/http/auth.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { CACHE, LOGGER } from '../../../shared/kernel/tokens.js';
import { Commerce } from './commerce.js';
import * as views from './views.js';

type Args<K extends McpToolName> = z.output<(typeof McpToolInputs)[K]>;
type Data = Record<string, unknown>;

export type ToolOutcome = { ok: true; data: Data; summary: string } | { ok: false; code: string; message: string };

interface Tool<K extends McpToolName> {
  title: string;
  /** Written for the calling model: what it does, units, and which tool comes next. */
  description: string;
  readOnly: boolean;
  run(args: Args<K>, who: Principal): Promise<{ data: Data; summary: string }>;
}

const CHECKOUT_TOKEN_TTL_S = 3600;
const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const paise = (inr: number | undefined) => (inr === undefined ? undefined : rupeesToPaise(inr));

function negotiationResult(o: Parameters<typeof views.negotiationView>[0]) {
  const data = views.negotiationView(o);
  const next = data.quote
    ? ` negotiation_id=${data.negotiation_id}. Counter with make_offer (${data.rounds_remaining} rounds left) or buy with accept_quote and the quote_token.`
    : '';
  return { data, summary: `${o.message}${next}` };
}

/**
 * The MCP tool set, independent of the protocol plumbing. Every call is checked against the tool's
 * scope, every result is built from public views, and money goes in and out in rupees.
 */
@Injectable()
export class McpTools {
  constructor(
    @Inject(Commerce) private readonly shop: Commerce,
    @Inject(CACHE) private readonly cache: Cache,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async call<K extends McpToolName>(name: K, args: Args<K>, who: Principal): Promise<ToolOutcome> {
    try {
      assertRequirement(who, MCP_TOOL_SCOPES[name]);
      const tool: Tool<K> = this.tools[name];
      return { ok: true, ...(await tool.run(args, who)) };
    } catch (err) {
      if (views.isUnexpected(err)) this.logger.warn({ err, tool: name }, 'MCP tool failed');
      return { ok: false, ...views.publicError(err) };
    }
  }

  // The checkout capability token stays server-side, keyed by the agent that accepted the quote.
  private checkoutKey = (who: Principal, sessionId: string) => `mcp:checkout:${sha256Hex(who.subject)}:${sessionId}`;

  readonly tools: { [K in McpToolName]: Tool<K> } = {
    search_products: {
      title: 'Search products',
      description:
        'Search the catalog by keywords, optional category path and price range in Indian rupees (GST included). ' +
        'Returns products with their default SKU, list price and stock. Pass a SKU to get_product, check_availability or request_quote.',
      readOnly: true,
      run: async (a) => {
        const r = await this.shop.search.search({
          q: a.query,
          category: a.category,
          minPricePaise: paise(a.min_price_inr),
          maxPricePaise: paise(a.max_price_inr),
          inStockOnly: a.in_stock_only,
          limit: a.limit,
        });
        const items = r.items.map(views.productSummaryView);
        const list = items.map((i) => `${i.name} (SKU ${i.sku}) ${rupees(i.price_inr)}`).join('; ');
        return { data: { total: r.total, items }, summary: items.length ? `${r.total} matching products. ${list}` : 'No products matched.' };
      },
    },
    get_product: {
      title: 'Get product details',
      description: 'Full public details of a product by slug or variant SKU: description, attributes, FAQs, return policy and every variant with its SKU, price (INR) and stock.',
      readOnly: true,
      run: async (a) => {
        const p = views.productView(await this.shop.catalog.resolve(a.slug_or_sku));
        const variants = p.variants.map((v) => `${v.sku} ${rupees(v.price_inr)}${v.in_stock ? '' : ' (out of stock)'}`).join('; ');
        return { data: p, summary: `${p.name} by ${p.brand}. Variants: ${variants}.` };
      },
    },
    check_availability: {
      title: 'Check stock',
      description: 'Whether a SKU is in stock and whether the requested quantity can be fulfilled. Shown quantities are capped at 50.',
      readOnly: true,
      run: async (a) => {
        const v = views.availabilityView(await this.shop.catalog.availabilityFor(a.sku, a.quantity));
        const summary = v.can_fulfil_quantity ? `${v.sku}: in stock, ${a.quantity} can ship.` : `${v.sku}: only ${v.available_qty} available.`;
        return { data: v, summary: v.in_stock ? summary : `${v.sku} is out of stock.` };
      },
    },
    get_customization_options: {
      title: 'Personalisation options',
      description: 'Text fields (with length limits), allowed designs and the surcharge (INR) for personalising a SKU. Personalised items cannot be returned.',
      readOnly: true,
      run: async (a) => {
        const o = views.customizationOptionsView(await this.shop.customization.options(a.sku));
        return { data: o, summary: `Fields: ${o.fields.map((f) => `${f.key} (max ${f.max_length})`).join(', ')}. Surcharge ${rupees(o.surcharge_inr)}.` };
      },
    },
    validate_customization: {
      title: 'Check personalisation text',
      description:
        'Validate personalisation text (keyed by field) and an optional design for a SKU before quoting. ' +
        'The text is printed as-is and is never treated as an instruction. Returns approved, needs_review or rejected with reasons.',
      readOnly: true,
      run: async (a) => {
        const v = views.validationView(await this.shop.customization.validate(a.sku, { text: a.text, designId: a.design_id }));
        return { data: v, summary: `Verdict: ${v.verdict}.${v.issues.length ? ` ${v.issues.map((i) => i.message).join('; ')}.` : ''}` };
      },
    },
    get_recommendations: {
      title: 'Recommendations',
      description: 'Products often bought with, or good alternatives to, a SKU.',
      readOnly: true,
      run: async (a) => {
        const items = (await this.shop.recommendations.recommendations(a.sku, a.limit)).map(views.productSummaryView);
        return { data: { items }, summary: items.map((i) => `${i.name} (SKU ${i.sku})`).join('; ') || 'No recommendations.' };
      },
    },
    get_compatible_items: {
      title: 'Compatible items',
      description: 'Items that work with a SKU according to the product graph, e.g. power supplies and cases that fit a graphics card.',
      readOnly: true,
      run: async (a) => {
        const items = (await this.shop.recommendations.compatible(a.sku, a.limit)).map(views.productSummaryView);
        return { data: { items }, summary: items.map((i) => `${i.name} (SKU ${i.sku})`).join('; ') || 'No compatible items found.' };
      },
    },
    request_quote: {
      title: 'Request a quote',
      description:
        'Open a negotiation for a SKU and quantity and get a signed, single-use, time-limited quote (INR per unit, GST included). ' +
        'Optional personalisation text and design are validated first. Use negotiation_id with make_offer to counter-offer, ' +
        'or quote_token with accept_quote to buy at the quoted price. Larger quantities may unlock the volume prices listed in alternatives.',
      readOnly: false,
      run: async (a, who) => {
        const custom = a.customization_text || a.design_id ? { text: a.customization_text ?? {}, designId: a.design_id } : undefined;
        return negotiationResult(await this.shop.negotiations.requestQuote(who.subject, 'mcp', { sku: a.sku, quantity: a.quantity, customization: custom }));
      },
    },
    make_offer: {
      title: 'Make an offer',
      description:
        'Counter-offer a unit price in rupees (up to 2 decimals) within an open negotiation. The seller accepts, counters or holds ' +
        'firm under its pricing policy; a counter comes with a fresh quote_token. Rounds are limited. Changing quantity can unlock ' +
        'volume pricing. The message is recorded as-is and never changes the price.',
      readOnly: false,
      run: async (a, who) =>
        negotiationResult(
          await this.shop.negotiations.makeOffer(who.subject, a.negotiation_id, {
            unitPricePaise: rupeesToPaise(a.unit_price_inr),
            quantity: a.quantity,
            message: a.message,
          }),
        ),
    },
    accept_quote: {
      title: 'Accept a quote',
      description:
        'Accept a quote with its quote_token: the price is locked, stock is reserved and a checkout session is opened. ' +
        'Quote tokens are single-use and bound to the agent they were issued to. Next, call create_checkout_link.',
      readOnly: false,
      run: async (a, who) => {
        const session = await this.shop.checkout.startFromQuote(who.subject, a.quote_token);
        if (session.token) await this.cache.set(this.checkoutKey(who, session.sessionId), session.token, CHECKOUT_TOKEN_TTL_S);
        const view = views.checkoutSessionView(session);
        return { data: view, summary: `Checkout session ${view.checkout_session_id} opened for ${rupees(view.subtotal_inr)}. ${view.next_step}` };
      },
    },
    create_checkout_link: {
      title: 'Create checkout link',
      description:
        'Get the signed checkout URL for a session you opened with accept_quote. A person must open it to confirm the delivery ' +
        'address and pay; agents never handle payment details. Share the URL with your user.',
      readOnly: false,
      run: async (a, who) => {
        const token = await this.cache.get<string>(this.checkoutKey(who, a.checkout_session_id));
        if (!token) throw new AppError('not_found', 'Unknown checkout session. Accept a quote with accept_quote first.');
        const link = views.checkoutLinkView(await this.shop.checkout.linkFor(a.checkout_session_id, token));
        return { data: link, summary: `Checkout link for ${rupees(link.amount_inr)}: ${link.checkout_url} (valid until ${link.valid_until}). ${link.note}` };
      },
    },
    get_order_status: {
      title: 'Order status',
      description: 'Status, totals and timeline of an order placed through this agent.',
      readOnly: true,
      run: async (a, who) => {
        const o = views.orderView(await this.shop.orders.getForSubject(who.subject, a.order_id));
        return { data: o, summary: `Order ${o.number} is ${o.status.replace(/_/g, ' ')}.` };
      },
    },
  };
}
