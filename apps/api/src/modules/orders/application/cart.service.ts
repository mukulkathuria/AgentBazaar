import { Inject, Injectable } from '@nestjs/common';
import { formatInr, MAX_PAISE, type CartLineInput, type CartView, type CustomizationValues } from '@agentbazaar/contracts';
import { sql } from 'drizzle-orm';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { DB } from '../../../shared/kernel/tokens.js';
import { CatalogService } from '../../catalog/index.js';
import { CustomizationService } from '../../customization/index.js';
import type { AcceptedQuote } from '../../pricing/index.js';
import { isUuid, lockLine, type LockedLine } from './locked-line.js';

const MAX_LINES = 50;

interface CartLineRow {
  id: string;
  variant_id: string;
  sku: string;
  quantity: number;
  customization: CustomizationValues | null;
}

interface PricedLine {
  lineId: string;
  line: LockedLine;
}

function view(cartId: string, priced: PricedLine[]): CartView {
  return {
    cartId,
    lines: priced.map(({ lineId, line: l }) => ({
      lineId,
      sku: l.sku,
      productName: l.productName,
      variantTitle: l.variantTitle,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      totalPaise: l.totalPaise,
      customization: l.customization,
      nonReturnable: l.nonReturnable,
    })),
    subtotalPaise: priced.reduce((s, p) => s + p.line.totalPaise, 0),
    currency: 'INR',
  };
}

/** Anonymous carts addressed by an unguessable id. Prices are always live; checkout locks them. */
@Injectable()
export class CartService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(CustomizationService) private readonly customization: CustomizationService,
  ) {}

  async create(subject: string): Promise<CartView> {
    const c = await one<{ id: string }>(
      this.db,
      sql`INSERT INTO carts (subject) VALUES (${subject}) RETURNING id`,
    );
    return view(c!.id, []);
  }

  async get(cartId: string): Promise<CartView> {
    await this.requireCart(this.db, cartId);
    return view(cartId, await this.price(this.db, cartId, false));
  }

  async addLine(cartId: string, input: CartLineInput): Promise<CartView> {
    await this.requireCart(this.db, cartId);
    const variant = await this.catalog.requireVariant(input.sku);
    const values = input.customization
      ? (await this.customization.requireAcceptable(variant.sku, input.customization)).validation.normalized
      : null;
    const count = await one<{ n: number }>(
      this.db,
      sql`SELECT count(*)::int AS n FROM cart_lines WHERE cart_id = ${cartId}`,
    );
    if ((count?.n ?? 0) >= MAX_LINES)
      throw new AppError('validation_failed', `A cart can hold at most ${MAX_LINES} lines`);
    return inTransaction(this.db, async (tx) => {
      await tx.execute(
        sql`INSERT INTO cart_lines (cart_id, variant_id, sku, quantity, customization)
            VALUES (${cartId}, ${variant.variantId}, ${variant.sku}, ${input.quantity}, ${values ? json(values) : null})`,
      );
      await tx.execute(sql`UPDATE carts SET updated_at = now() WHERE id = ${cartId}`);
      return this.withinLimit(tx, cartId);
    });
  }

  async updateLine(cartId: string, lineId: string, quantity: number): Promise<CartView> {
    if (!isUuid(cartId) || !isUuid(lineId)) throw notFound('Cart line');
    return inTransaction(this.db, async (tx) => {
      const r = await one<{ id: string }>(
        tx,
        sql`UPDATE cart_lines SET quantity = ${quantity} WHERE id = ${lineId} AND cart_id = ${cartId} RETURNING id`,
      );
      if (!r) throw notFound('Cart line');
      return this.withinLimit(tx, cartId);
    });
  }

  async removeLine(cartId: string, lineId: string): Promise<CartView> {
    const r =
      isUuid(cartId) && isUuid(lineId)
        ? await one<{ id: string }>(
            this.db,
            sql`DELETE FROM cart_lines WHERE id = ${lineId} AND cart_id = ${cartId} RETURNING id`,
          )
        : undefined;
    if (!r) throw notFound('Cart line');
    return this.get(cartId);
  }

  /** Re-prices the cart from the catalog and re-validates customization, inside the checkout transaction. */
  async lockLines(tx: Executor, cartId: string): Promise<LockedLine[]> {
    await this.requireCart(tx, cartId);
    const lines = (await this.price(tx, cartId, true)).map((p) => p.line);
    if (!lines.length) throw new AppError('validation_failed', 'Your cart is empty');
    return lines;
  }

  /** The single line of an accepted quote, at the negotiated price. */
  async lockQuote(tx: Executor, q: AcceptedQuote): Promise<LockedLine> {
    const v = await this.catalog.requireVariant(q.variantId, tx);
    const flagged = q.customization
      ? (await this.customization.requireAcceptable(v.sku, q.customization, tx)).flagged
      : [];
    return lockLine(v, q.quantity, q.unitPricePaise, q.customization, flagged);
  }

  async clear(tx: Executor, cartId: string): Promise<void> {
    await tx.execute(sql`DELETE FROM cart_lines WHERE cart_id = ${cartId}`);
  }

  /** Prices include GST, so a cart over the contracts' money ceiling would make an order no contract can carry. */
  private async withinLimit(tx: Executor, cartId: string): Promise<CartView> {
    const v = view(cartId, await this.price(tx, cartId, false));
    if (v.subtotalPaise > MAX_PAISE) throw new AppError('validation_failed', `A cart can total at most ${formatInr(MAX_PAISE)}`);
    return v;
  }

  private async requireCart(ex: Executor, cartId: string): Promise<void> {
    const c = isUuid(cartId)
      ? await one<{ id: string }>(ex, sql`SELECT id FROM carts WHERE id = ${cartId}`)
      : undefined;
    if (!c) throw notFound('Cart');
  }

  /** Strict mode (checkout) refuses unavailable items and rejected text; the cart view just skips or shows them. */
  private async price(ex: Executor, cartId: string, strict: boolean): Promise<PricedLine[]> {
    const lines = await rows<CartLineRow>(
      ex,
      sql`SELECT id, variant_id, sku, quantity, customization FROM cart_lines WHERE cart_id = ${cartId} ORDER BY created_at, id`,
    );
    const out: PricedLine[] = [];
    for (const l of lines) {
      const v = await this.catalog.findVariant(l.variant_id, ex);
      if (!v) {
        if (strict)
          throw new AppError(
            'validation_failed',
            `${l.sku} is no longer available. Remove it from your cart.`,
          );
        continue;
      }
      if (!l.customization) {
        out.push({ lineId: l.id, line: lockLine(v, l.quantity, v.pricePaise, null, []) });
        continue;
      }
      const checked = strict
        ? await this.customization.requireAcceptable(v.sku, l.customization, ex)
        : await this.customization.check(v.sku, l.customization, ex);
      const unit = v.pricePaise + checked.validation.surchargePaise;
      out.push({
        lineId: l.id,
        line: lockLine(
          v,
          l.quantity,
          unit,
          checked.validation.normalized ?? l.customization,
          checked.flagged,
        ),
      });
    }
    return out;
  }
}
