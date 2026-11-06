import { describe, expect, it } from 'vitest';
import { coPurchasePairs, inStockFirst, MAX_LEARN_PRODUCTS, supportsPgq } from './graph.js';

describe('@lite product graph rules', () => {
  it('pairs distinct products once each, smaller id first', () => {
    expect(coPurchasePairs(['c', 'a', 'b', 'a'])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
    expect(coPurchasePairs(['only'])).toEqual([]);
    expect(coPurchasePairs([])).toEqual([]);
  });

  it('caps the products a single order can pair', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const pairs = coPurchasePairs(ids);
    expect(pairs).toHaveLength((MAX_LEARN_PRODUCTS * (MAX_LEARN_PRODUCTS - 1)) / 2);
    expect(new Set(pairs.flat()).size).toBe(MAX_LEARN_PRODUCTS);
  });

  it('puts in-stock items first without reordering within each group', () => {
    const items = [
      { id: 1, inStock: false },
      { id: 2, inStock: true },
      { id: 3, inStock: false },
      { id: 4, inStock: true },
    ];
    expect(inStockFirst(items).map((i) => i.id)).toEqual([2, 4, 1, 3]);
  });

  it('uses SQL/PGQ only from PostgreSQL 19', () => {
    expect(supportsPgq(180_006)).toBe(false);
    expect(supportsPgq(190_000)).toBe(true);
    expect(supportsPgq(0)).toBe(false);
  });
});
