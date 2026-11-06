import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import {
  type CustomizationOptions,
  type CustomizationValidation,
  CustomizationValues,
  type TextFieldSpec,
} from '@agentbazaar/contracts';
import type { SeedCustomizationSchema, SeedDesign } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { inTransaction, one, rows, type Executor } from '../../../shared/db/database.js';
import { json } from '../../../shared/db/sql-helpers.js';
import { AppError, notFound } from '../../../shared/kernel/errors.js';
import { CONFIG, DB } from '../../../shared/kernel/tokens.js';
import { AuditService } from '../../audit/index.js';
import { CatalogService, type VariantRef } from '../../catalog/index.js';
import { renderPreview } from '../domain/preview.js';
import { validateValues, type ValidationOutcome } from '../domain/validator.js';

const NOTICE = 'Personalised items are made to order and cannot be returned unless they arrive damaged.';

interface SchemaRow {
  id: string;
  product_type: string;
  fields: TextFieldSpec[];
  design_required: boolean;
  surcharge_paise: number;
}

interface ReviewRow {
  id: string;
  sku: string;
  field: string;
  text: string;
  flags: string[];
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
}

export interface CheckedCustomization {
  validation: CustomizationValidation;
  flagged: ValidationOutcome['flagged'];
  variant: VariantRef;
}

const reviewView = (x: ReviewRow) => ({
  id: x.id,
  sku: x.sku,
  field: x.field,
  text: x.text,
  flags: x.flags,
  status: x.status,
  createdAt: x.created_at.toISOString(),
});

@Injectable()
export class CustomizationService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async schemaFor(variant: VariantRef, ex: Executor): Promise<SchemaRow> {
    if (!variant.customizationSchemaId) throw new AppError('validation_failed', `${variant.productName} cannot be customized`);
    const s = await one<SchemaRow>(
      ex,
      sql`SELECT id, product_type, fields, design_required, surcharge_paise FROM customization_schemas WHERE id = ${variant.customizationSchemaId}`,
    );
    if (!s) throw notFound('Customization schema');
    return s;
  }

  private async designsFor(productType: string, ex: Executor): Promise<{ id: string; name: string; svg: string }[]> {
    return rows(
      ex,
      sql`SELECT d.id, d.name, d.svg FROM designs d JOIN design_allowed_on a ON a.design_id = d.id
          WHERE a.product_type = ${productType} AND d.status = 'active' ORDER BY d.name`,
    );
  }

  private previewUrl(sku: string, values: CustomizationValues): string {
    const d = Buffer.from(JSON.stringify(values)).toString('base64url');
    return `${this.config.env.PUBLIC_API_URL}/api/v1/customization/${encodeURIComponent(sku)}/preview.svg?d=${d}`;
  }

  async options(sku: string): Promise<CustomizationOptions> {
    const variant = await this.catalog.requireVariant(sku);
    const schema = await this.schemaFor(variant, this.db);
    const designs = await this.designsFor(schema.product_type, this.db);
    return {
      productId: variant.productId,
      schemaId: schema.id,
      fields: schema.fields,
      designs: designs.map((d) => ({
        id: d.id,
        name: d.name,
        previewUrl: `data:image/svg+xml;base64,${Buffer.from(d.svg).toString('base64')}`,
      })),
      designRequired: schema.design_required,
      surchargePaise: schema.surcharge_paise,
      nonReturnable: true,
      notice: NOTICE,
    };
  }

  /** Validates values for a SKU. Never trusts the caller: used by REST, MCP, cart, quotes and checkout. */
  async check(sku: string, values: CustomizationValues, ex: Executor = this.db): Promise<CheckedCustomization> {
    const variant = await this.catalog.requireVariant(sku, ex);
    const schema = await this.schemaFor(variant, ex);
    const designs = await this.designsFor(schema.product_type, ex);
    const outcome = validateValues(
      schema.fields,
      { allowedDesignIds: new Set(designs.map((d) => d.id)), designRequired: schema.design_required },
      values,
    );
    return {
      variant,
      flagged: outcome.flagged,
      validation: {
        verdict: outcome.verdict,
        issues: outcome.issues,
        normalized: outcome.normalized,
        surchargePaise: schema.surcharge_paise,
        previewUrl: outcome.normalized ? this.previewUrl(variant.sku, outcome.normalized) : null,
      },
    };
  }

  async validate(sku: string, values: CustomizationValues): Promise<CustomizationValidation> {
    return (await this.check(sku, values)).validation;
  }

  /** Throws unless approved or reviewable; returns normalised values and the surcharge. */
  async requireAcceptable(sku: string, values: CustomizationValues, ex: Executor = this.db): Promise<CheckedCustomization> {
    const checked = await this.check(sku, values, ex);
    if (checked.validation.verdict === 'rejected') {
      throw new AppError('validation_failed', 'This customization cannot be accepted', checked.validation.issues);
    }
    return checked;
  }

  async previewSvg(sku: string, encoded: string): Promise<string> {
    if (encoded.length > 4000) throw new AppError('validation_failed', 'Preview data too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('validation_failed', 'Invalid preview data');
    }
    const values = CustomizationValues.safeParse(parsed);
    if (!values.success) throw new AppError('validation_failed', 'Invalid preview data');
    const { validation, variant } = await this.check(sku, values.data);
    const normalized = validation.normalized;
    if (!normalized) throw new AppError('validation_failed', 'This customization cannot be previewed', validation.issues);
    const schema = await this.schemaFor(variant, this.db);
    const design = normalized.designId
      ? ((await this.designsFor(schema.product_type, this.db)).find((d) => d.id === normalized.designId)?.svg ?? null)
      : null;
    return renderPreview(
      schema.product_type,
      design,
      schema.fields.map((f) => normalized.text[f.key] ?? ''),
    );
  }

  /** Queues flagged text for a human before production (called at order time). */
  async flagForReview(tx: Executor, sku: string, flagged: CheckedCustomization['flagged']): Promise<void> {
    for (const f of flagged) {
      await tx.execute(
        sql`INSERT INTO customization_reviews (sku, field, text, flags)
            VALUES (${sku}, ${f.field}, ${f.text}, ${`{${f.flags.join(',')}}`}::text[]) ON CONFLICT DO NOTHING`,
      );
    }
  }

  async listReviews() {
    const r = await rows<ReviewRow>(
      this.db,
      sql`SELECT id, sku, field, text, flags, status, created_at FROM customization_reviews
          ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200`,
    );
    return r.map(reviewView);
  }

  async decideReview(id: string, approve: boolean, note: string | undefined, actor: string) {
    return inTransaction(this.db, async (tx) => {
      const r = await one<ReviewRow>(
        tx,
        sql`UPDATE customization_reviews SET status = ${approve ? 'approved' : 'rejected'}, decided_by = ${actor},
              note = ${note ?? null}, decided_at = now()
            WHERE id = ${id} AND status = 'pending'
            RETURNING id, sku, field, text, flags, status, created_at`,
      );
      if (!r) throw new AppError('conflict', 'Review not found or already decided');
      await this.audit.record(tx, actor, approve ? 'customization.approved' : 'customization.rejected', id, { sku: r.sku });
      return reviewView(r);
    });
  }

  async importSeed(
    tx: Executor,
    schemas: readonly SeedCustomizationSchema[],
    designs: readonly SeedDesign[],
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const s of schemas) {
      const r = await one<{ id: string }>(
        tx,
        sql`INSERT INTO customization_schemas (name, product_type, fields, design_required, surcharge_paise)
            VALUES (${s.name}, ${s.productType}, ${json(s.fields)}, ${s.designRequired}, ${s.surchargePaise})
            ON CONFLICT (name) DO UPDATE SET fields = EXCLUDED.fields RETURNING id`,
      );
      ids.set(s.name, r!.id);
    }
    for (const d of designs) {
      const r = await one<{ id: string }>(tx, sql`INSERT INTO designs (name, svg) VALUES (${d.name}, ${d.svg}) RETURNING id`);
      for (const type of d.allowedOn) {
        await tx.execute(sql`INSERT INTO design_allowed_on (design_id, product_type) VALUES (${r!.id}, ${type}) ON CONFLICT DO NOTHING`);
      }
    }
    return ids;
  }
}
