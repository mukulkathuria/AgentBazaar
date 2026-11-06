export type EdgeKind = 'compatible_with' | 'bought_together' | 'alternative_of';

/** SQL/PGQ (GRAPH_TABLE) ships with PostgreSQL 19. */
export const PGQ_MIN_SERVER_VERSION = 190_000;
export const supportsPgq = (serverVersionNum: number): boolean => serverVersionNum >= PGQ_MIN_SERVER_VERSION;

/** Products per order the learner pairs up: 10 products give at most 45 pairs. */
export const MAX_LEARN_PRODUCTS = 10;

/** Unordered pairs (a < b) of distinct products bought together, capped so a huge cart stays cheap. */
export function coPurchasePairs(productIds: readonly string[], maxProducts = MAX_LEARN_PRODUCTS): [string, string][] {
  const ids = [...new Set(productIds)].slice(0, maxProducts).sort();
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i]!, ids[j]!]);
  return pairs;
}

/** In-stock items first; the graph's order is kept otherwise (sort is stable). */
export const inStockFirst = <T extends { inStock: boolean }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => Number(b.inStock) - Number(a.inStock));
