/** Display cap so exact stock levels are not leaked to scrapers or competitor agents. */
export const AVAILABLE_DISPLAY_CAP = 50;

export const displayQty = (available: number): number => Math.max(0, Math.min(AVAILABLE_DISPLAY_CAP, available));

export interface ReserveLine {
  variantId: string;
  quantity: number;
}

/**
 * Merges duplicate variants and sorts by id so every transaction locks stock rows in the same
 * order, which rules out deadlocks between concurrent multi-line checkouts.
 */
export function normaliseLines(lines: readonly ReserveLine[]): ReserveLine[] {
  const merged = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new RangeError('Quantity must be a positive integer');
    merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([variantId, quantity]) => ({ variantId, quantity }));
}
