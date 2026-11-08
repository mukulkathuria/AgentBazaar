/** Reciprocal Rank Fusion constant from Cormack et al.; the Postgres adapter uses it in SQL too. */
export const RRF_K = 60;

/**
 * Cosine similarity a vector hit needs to count. Measured on the synthetic catalog, unrelated
 * documents reach about 0.29 with hash vectors (colliding buckets) while typos of real words score 0.4+.
 */
export const MIN_VECTOR_SIMILARITY = 0.3;

/**
 * Higher score first, then product id ascending in code-unit order (the order of OpenSearch's keyword sort and of
 * Postgres's uuid), so equal scores always come back in the same order and pages neither repeat nor skip a product.
 */
export const byScoreThenId = (a: { id: string; score: number }, b: { id: string; score: number }): number =>
  b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Fuses ranked id lists: score(id) = sum over lists of 1 / (k + rank), rank starting at 1. */
export function reciprocalRankFusion(rankings: readonly (readonly string[])[], k = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of rankings) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort(byScoreThenId);
}
