import type { PublicProduct } from '@agentbazaar/contracts';
import { describe, expect, it } from 'vitest';
import { productJsonLd, serializeJsonLd } from './jsonld';

const product: PublicProduct = {
  id: '0b9f6c4e-2f6a-4d55-9a57-8f7a6f0e1a11',
  slug: 'thock-tk87-mechanical-keyboard',
  name: 'Thock TK87 Mechanical Keyboard',
  brand: 'Thock',
  description: 'Tenkeyless hot-swap keyboard.',
  category: { slug: 'keyboards', name: 'Keyboards', path: 'electronics.peripherals.keyboards' },
  breadcrumbs: [],
  band: 'standard',
  customizable: false,
  returnable: true,
  returnWindowDays: 7,
  attributes: { switches: 'Red' },
  images: [],
  variants: [
    {
      id: '6d1f1f0e-7d1a-4c39-bf0e-2b7c1f5a9e01',
      sku: 'TK87-RED',
      title: 'Red switches',
      options: { switch: 'Red', color: 'Black' },
      pricePaise: 349_900,
      mrpPaise: 449_900,
      currency: 'INR',
      inStock: true,
      availableQty: 12,
    },
    {
      id: '6d1f1f0e-7d1a-4c39-bf0e-2b7c1f5a9e02',
      sku: 'TK87-BROWN',
      title: 'Brown switches',
      options: { switch: 'Brown', color: 'Black' },
      pricePaise: 35_050,
      mrpPaise: 35_050,
      currency: 'INR',
      inStock: false,
      availableQty: 0,
    },
  ],
  rating: { average: 4.6, count: 128 },
  faqs: [],
  updatedAt: '2026-11-01T10:00:00Z',
};

describe('product JSON-LD', () => {
  it('builds a ProductGroup with one Product + Offer per variant, prices in rupees', () => {
    const ld = productJsonLd(product, 'https://shop.example');
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'ProductGroup',
      brand: { '@type': 'Brand', name: 'Thock' },
      variesBy: ['https://schema.org/color'],
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, ratingCount: 128 },
      hasVariant: [
        {
          '@type': 'Product',
          sku: 'TK87-RED',
          url: 'https://shop.example/p/thock-tk87-mechanical-keyboard?sku=TK87-RED',
          offers: {
            '@type': 'Offer',
            price: '3499.00',
            priceCurrency: 'INR',
            availability: 'https://schema.org/InStock',
            itemCondition: 'https://schema.org/NewCondition',
            hasMerchantReturnPolicy: {
              returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
              merchantReturnDays: 7,
              applicableCountry: 'IN',
            },
            // free above the placeholder threshold
            shippingDetails: { shippingRate: { value: '0.00', currency: 'INR' }, shippingDestination: { addressCountry: 'IN' } },
          },
        },
        {
          sku: 'TK87-BROWN',
          offers: {
            price: '350.50',
            availability: 'https://schema.org/OutOfStock',
            shippingDetails: { shippingRate: { value: '49.00' } },
          },
        },
      ],
    });
  });

  it('marks non-returnable products and omits a missing rating', () => {
    const ld = productJsonLd({ ...product, returnable: false, rating: null }, 'https://shop.example');
    expect(ld.aggregateRating).toBeUndefined();
    expect(ld).toMatchObject({
      hasVariant: [
        { offers: { hasMerchantReturnPolicy: { returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted' } } },
        { offers: { hasMerchantReturnPolicy: { returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted' } } },
      ],
    });
  });

  it('serialises safely inside a script element', () => {
    const hostile = { ...product, name: 'Evil </script><script>alert(1)</script> & co', description: '<!-- x --> \u2028' };
    const json = serializeJsonLd(productJsonLd(hostile, 'https://shop.example'));
    expect(json).not.toMatch(/<\/script/i);
    expect(json).not.toContain('<');
    expect(json).not.toContain(String.fromCharCode(0x2028));
    expect((JSON.parse(json) as { name: string; description: string }).name).toBe(hostile.name);
    expect((JSON.parse(json) as { name: string; description: string }).description).toBe(hostile.description);
  });
});
