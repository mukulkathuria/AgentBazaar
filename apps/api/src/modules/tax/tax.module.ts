import { Inject, Injectable, Module } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import { GST_STATES, type GstStateCode } from '@agentbazaar/contracts';
import type { SeedGstRate } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { one, type Executor } from '../../shared/db/database.js';
import { json } from '../../shared/db/sql-helpers.js';
import type { Clock } from '../../shared/kernel/clock.js';
import { AppError } from '../../shared/kernel/errors.js';
import { CLOCK, CONFIG, DB } from '../../shared/kernel/tokens.js';
import { financialYear, gstForLine, invoiceNumber, type LineTax } from './domain/gst.js';

export interface TaxableLine {
  hsnCode: string;
  totalPaise: number;
}

export interface InvoiceLine {
  sku: string;
  productName: string;
  hsnCode: string;
  quantity: number;
  unitPricePaise: number;
  totalPaise: number;
  taxablePaise: number;
  taxes: LineTax['taxes'];
}

@Injectable()
export class TaxService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  get sellerState(): string {
    return this.config.env.SELLER_STATE_CODE;
  }

  async rateBps(hsnCode: string, ex: Executor = this.db): Promise<number> {
    const r = await one<{ rate_bps: number }>(
      ex,
      sql`SELECT rate_bps FROM gst_rates WHERE hsn_code = ${hsnCode} AND effective_from <= ${this.clock.now()}::date
          ORDER BY effective_from DESC LIMIT 1`,
    );
    if (!r) throw new AppError('pricing_misconfigured', `No GST rate configured for HSN ${hsnCode}`);
    return r.rate_bps;
  }

  async computeLines(lines: readonly TaxableLine[], placeOfSupply: GstStateCode, ex: Executor = this.db): Promise<LineTax[]> {
    const intra = placeOfSupply === this.sellerState;
    const out: LineTax[] = [];
    for (const l of lines) out.push(gstForLine(l.totalPaise, await this.rateBps(l.hsnCode, ex), intra));
    return out;
  }

  /** Issues the GST invoice once per order with a gap-free number for the financial year. */
  async issueInvoice(tx: Executor, orderId: string, placeOfSupply: string, lines: InvoiceLine[]): Promise<string> {
    const existing = await one<{ number: string }>(tx, sql`SELECT number FROM invoices WHERE order_id = ${orderId}`);
    if (existing) return existing.number;
    const fy = financialYear(this.clock.now());
    const c = await one<{ last_number: number }>(
      tx,
      sql`INSERT INTO invoice_counters (financial_year, last_number) VALUES (${fy}, 1)
          ON CONFLICT (financial_year) DO UPDATE SET last_number = invoice_counters.last_number + 1 RETURNING last_number`,
    );
    const number = invoiceNumber(fy, c!.last_number);
    const totals = lines.reduce(
      (t, l) => ({ taxable: t.taxable + l.taxablePaise, tax: t.tax + (l.totalPaise - l.taxablePaise), total: t.total + l.totalPaise }),
      { taxable: 0, tax: 0, total: 0 },
    );
    const env = this.config.env;
    const seller = {
      name: env.SELLER_NAME,
      gstin: env.SELLER_GSTIN ?? null,
      state: env.SELLER_STATE_CODE,
      stateCode: GST_STATES[env.SELLER_STATE_CODE as GstStateCode] ?? null,
    };
    await tx.execute(
      sql`INSERT INTO invoices (order_id, number, financial_year, seller, place_of_supply, lines, totals)
          VALUES (${orderId}, ${number}, ${fy}, ${json(seller)}, ${placeOfSupply}, ${json(lines)}, ${json(totals)})`,
    );
    return number;
  }

  async importRates(tx: Executor, rates: readonly SeedGstRate[]): Promise<void> {
    for (const r of rates) {
      await tx.execute(
        sql`INSERT INTO gst_rates (hsn_code, rate_bps, effective_from, description)
            VALUES (${r.hsnCode}, ${r.rateBps}, ${r.effectiveFrom}::date, ${r.description}) ON CONFLICT DO NOTHING`,
      );
    }
  }
}

@Module({ providers: [TaxService], exports: [TaxService] })
export class TaxModule {}
