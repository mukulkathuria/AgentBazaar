import { Inject, Injectable } from '@nestjs/common';
import type { ProductSummary } from '@agentbazaar/contracts';
import type { SeedEdge } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { rows, type Executor } from '../../../shared/db/database.js';
import { pgArray } from '../../../shared/db/sql-helpers.js';
import { notFound } from '../../../shared/kernel/errors.js';
import type { Subscription } from '../../../shared/outbox/outbox.js';
import { CatalogService } from '../../catalog/index.js';
import { coPurchasePairs, inStockFirst } from '../domain/graph.js';
import { GRAPH_REPOSITORY, type GraphRepository, type RelatedProduct } from './graph-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RecommendationsService {
  constructor(
    @Inject(GRAPH_REPOSITORY) private readonly graph: GraphRepository,
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  /** Items that work with this product (e.g. PSUs and cases for a GPU), in-stock first. */
  async compatible(slugOrSku: string, limit = 12): Promise<ProductSummary[]> {
    const id = await this.productId(slugOrSku);
    // Fetch extra candidates so in-stock items can move up before the cut.
    const related = await this.graph.related(id, ['compatible_with'], limit * 3);
    return inStockFirst(await this.summaries(id, related)).slice(0, limit);
  }

  /** Bought-together items first, then alternatives. */
  async recommendations(slugOrSku: string, limit = 12): Promise<ProductSummary[]> {
    const id = await this.productId(slugOrSku);
    const related = await this.graph.related(id, ['bought_together', 'alternative_of'], limit * 2);
    return (await this.summaries(id, related)).slice(0, limit);
  }

  /** Bulk seed import. Edges whose products are unknown are skipped. Returns the edges inserted. */
  async importEdges(tx: Executor, edges: readonly SeedEdge[], slugToId: ReadonlyMap<string, string>): Promise<number> {
    const resolved = edges.flatMap((e) => {
      const [a, b] = [slugToId.get(e.from), slugToId.get(e.to)];
      return a && b && a !== b ? [{ ...e, a, b }] : [];
    });
    let inserted = 0;
    for (let i = 0; i < resolved.length; i += 500) {
      const chunk = resolved.slice(i, i + 500);
      const r = await rows<{ id: string }>(
        tx,
        sql`INSERT INTO product_edges (a_id, b_id, kind, rule, weight)
            VALUES ${sql.join(
              chunk.map((e) => sql`(${e.a}, ${e.b}, ${e.kind}, ${e.rule}, ${e.weight})`),
              sql`, `,
            )}
            ON CONFLICT (a_id, b_id, kind) DO NOTHING RETURNING id`,
      );
      inserted += r.length;
    }
    return inserted;
  }

  /**
   * Strengthens `bought_together` for every pair in a paid order: an existing edge in either
   * direction gains 1, otherwise a new edge starts at 1. Returns the pairs counted.
   */
  async learnFromOrder(tx: Executor, productIds: readonly string[]): Promise<number> {
    const pairs = coPurchasePairs(productIds.filter((id) => UUID.test(id)));
    if (!pairs.length) return 0;
    const as = pgArray(
      pairs.map((p) => p[0]),
      'uuid',
    );
    const bs = pgArray(
      pairs.map((p) => p[1]),
      'uuid',
    );
    await tx.execute(sql`
      WITH pairs AS (SELECT * FROM unnest(${as}, ${bs}) AS p(a, b)),
      bumped AS (
        UPDATE product_edges e SET weight = e.weight + 1 FROM pairs p
        WHERE e.kind = 'bought_together' AND ((e.a_id = p.a AND e.b_id = p.b) OR (e.a_id = p.b AND e.b_id = p.a))
        RETURNING p.a, p.b)
      INSERT INTO product_edges (a_id, b_id, kind, weight)
      SELECT a, b, 'bought_together', 1 FROM pairs p WHERE NOT EXISTS (SELECT 1 FROM bumped x WHERE x.a = p.a AND x.b = p.b)
      ON CONFLICT (a_id, b_id, kind) DO UPDATE SET weight = product_edges.weight + 1`);
    return pairs.length;
  }

  /** Consumer `recs-learner` on `order.paid` ({ orderId, productIds }). */
  learnerSubscription(): Subscription {
    return {
      consumer: 'recs-learner',
      topics: ['order.paid'],
      handler: async (event, tx) => {
        const ids = event.payload.productIds;
        await this.learnFromOrder(tx, Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
      },
    };
  }

  private async productId(slugOrSku: string): Promise<string> {
    const key = slugOrSku.trim();
    const bySlug = (await this.catalog.productIdsBySlugs([key.toLowerCase()])).get(key.toLowerCase());
    const id = bySlug ?? (await this.catalog.findVariant(key))?.productId;
    if (!id) throw notFound('Product');
    return id;
  }

  private summaries(self: string, related: readonly RelatedProduct[]): Promise<ProductSummary[]> {
    return this.catalog.summaries([...new Set(related.map((r) => r.productId))].filter((id) => id !== self));
  }
}
