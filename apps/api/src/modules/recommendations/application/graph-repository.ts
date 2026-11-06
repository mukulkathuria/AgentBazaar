import type { EdgeKind } from '../domain/graph.js';

export interface RelatedProduct {
  productId: string;
  kind: EdgeKind;
  weight: number;
}

/**
 * Fixed-hop reads over `product_edges`. Plain joins everywhere; SQL/PGQ on PostgreSQL 19+.
 * Queries are fixed and parameterised: no caller (and no LLM) ever supplies SQL.
 */
export interface GraphRepository {
  readonly engine: 'sql' | 'pgq';
  /** Neighbours over edges in either direction, ordered by the position of their kind in `kinds`, then weight. */
  related(productId: string, kinds: readonly EdgeKind[], limit: number): Promise<RelatedProduct[]>;
}

export const GRAPH_REPOSITORY = Symbol('GRAPH_REPOSITORY');
