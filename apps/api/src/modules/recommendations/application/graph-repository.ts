import type { Executor } from '../../../shared/db/database.js';
import type { EdgeKind } from '../domain/graph.js';

export interface RelatedProduct {
  productId: string;
  kind: EdgeKind;
  weight: number;
}

export interface SetupItem {
  productId: string;
  score: number;
}

/** A `product_edges` row (a → b) written in the caller's transaction. */
export interface EdgeKey {
  a: string;
  b: string;
  kind: EdgeKind;
}

/**
 * Fixed-hop reads over `product_edges`, the source of truth: plain joins everywhere, openCypher on Apache AGE.
 * Every relation is symmetric, and a pair related both ways counts once, with its larger weight.
 * Queries are fixed and parameterised: no caller (and no LLM) ever supplies SQL or Cypher.
 */
export interface GraphRepository {
  readonly engine: 'sql' | 'age';
  /** Neighbours over edges in either direction, ordered by the position of their kind in `kinds`, then weight. */
  related(productId: string, kinds: readonly EdgeKind[], limit: number): Promise<RelatedProduct[]>;
  /**
   * "Complete the setup": products Y bought together with an item X compatible with P, two hops out. P itself and
   * everything directly related to P (any kind) are excluded. Each path P–X–Y scores compatible(P, X) ×
   * bought_together(X, Y); Y's score is the sum over its paths. Ordered by score, then id.
   */
  completeTheSetup(productId: string, limit: number): Promise<SetupItem[]>;
  /** Mirrors `product_edges` rows written in `tx` into the graph store in that same transaction; joins need nothing. */
  upsertEdges(tx: Executor, edges: readonly EdgeKey[]): Promise<void>;
}

export const GRAPH_REPOSITORY = Symbol('GRAPH_REPOSITORY');
