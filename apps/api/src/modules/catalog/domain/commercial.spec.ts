import type { AttributeDef } from '@agentbazaar/contracts';
import { describe, expect, it } from 'vitest';
import { floorPaise, productBand, validateAttributes } from './commercial.js';

const def = (d: Partial<AttributeDef> & Pick<AttributeDef, 'key' | 'type'>): AttributeDef => ({ label: d.key, required: false, ...d });

describe('@lite catalog commercial rules', () => {
  it('floors at landed cost plus minimum margin, rounded up to the paisa', () => {
    expect(floorPaise(100_000, {}, 0)).toBe(100_000);
    expect(floorPaise(100_000, {}, 1000)).toBe(110_000);
    // 100,000 + 5,000 + 2,000 + 1,500 + 500 = 109,000 landed, plus 12.5%.
    expect(floorPaise(100_000, { freight: 5_000, paymentFee: 2_000, expectedReturnCost: 1_500, nonRecoverableTax: 500 }, 1250)).toBe(122_625);
    // Each landed-cost part counts on its own.
    expect(floorPaise(0, { freight: 1 }, 0)).toBe(1);
    expect(floorPaise(0, { paymentFee: 2 }, 0)).toBe(2);
    expect(floorPaise(0, { expectedReturnCost: 3 }, 0)).toBe(3);
    expect(floorPaise(0, { nonRecoverableTax: 4 }, 0)).toBe(4);
    // 333 x 1.0001 = 333.0333 -> 334: never rounds the floor down.
    expect(floorPaise(333, {}, 1)).toBe(334);
  });

  it('bands a product by its most expensive variant', () => {
    expect(productBand([10_000, 49_999])).toBe('fixed');
    expect(productBand([10_000, 50_000])).toBe('standard');
    expect(productBand([60_000, 2_000_000])).toBe('standard');
    expect(productBand([2_000_001, 10_000])).toBe('premium');
  });

  describe('attribute validation', () => {
    const defs: AttributeDef[] = [
      def({ key: 'colour', type: 'string', required: true }),
      def({ key: 'weight_g', type: 'number' }),
      def({ key: 'wireless', type: 'boolean' }),
      def({ key: 'layout', type: 'enum', values: ['ansi', 'iso'] }),
    ];

    it('accepts values of the declared types', () => {
      expect(validateAttributes(defs, { colour: 'black', weight_g: 850, wireless: false, layout: 'iso' })).toEqual([]);
    });

    it('reports missing required attributes and unknown keys', () => {
      expect(validateAttributes(defs, { size: 'xl' })).toEqual(['colour is required', 'size is not an attribute of this category']);
    });

    it('accepts free-form attributes when the category declares none', () => {
      expect(validateAttributes([], { anything: 'goes', n: 1 })).toEqual([]);
    });

    it('names the expected type, or the allowed values for an enum', () => {
      expect(
        validateAttributes(defs, { colour: 7, weight_g: 'heavy', wireless: 'yes', layout: 'jis' }),
      ).toEqual(['colour must be a string', 'weight_g must be a number', 'wireless must be a boolean', 'layout must be one of ansi, iso']);
      expect(validateAttributes(defs, { colour: 'red', weight_g: Number.POSITIVE_INFINITY })).toEqual(['weight_g must be a number']);
      expect(validateAttributes(defs, { colour: 'red', layout: 1 })).toEqual(['layout must be one of ansi, iso']);
    });

    it('treats an enum without values as accepting nothing', () => {
      expect(validateAttributes([def({ key: 'finish', type: 'enum' })], { finish: 'matte' })).toEqual(['finish must be one of ']);
    });
  });
});
