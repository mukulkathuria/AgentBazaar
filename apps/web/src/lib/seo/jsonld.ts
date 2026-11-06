import { paiseToDecimalString, type PublicProduct } from '@agentbazaar/contracts';
import { apiAssetUrl } from '../urls';

/** Placeholder shipping terms for structured data: configurable, set them to your real rates. */
export const SHIPPING = {
  freeAbovePaise: 49_900,
  flatRatePaise: 4_900,
  handlingDays: [0, 1],
  transitDays: [2, 7],
} as const;

const VARIES_BY: Record<string, string> = {
  color: 'https://schema.org/color',
  colour: 'https://schema.org/color',
  size: 'https://schema.org/size',
  material: 'https://schema.org/material',
  pattern: 'https://schema.org/pattern',
};

const days = ([minValue, maxValue]: readonly [number, number]) => ({
  '@type': 'QuantitativeValue',
  minValue,
  maxValue,
  unitCode: 'DAY',
});

function shippingDetails(pricePaise: number) {
  const rate = pricePaise >= SHIPPING.freeAbovePaise ? 0 : SHIPPING.flatRatePaise;
  return {
    '@type': 'OfferShippingDetails',
    shippingRate: { '@type': 'MonetaryAmount', value: paiseToDecimalString(rate), currency: 'INR' },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'IN' },
    deliveryTime: {
      '@type': 'ShippingDeliveryTime',
      handlingTime: days(SHIPPING.handlingDays),
      transitTime: days(SHIPPING.transitDays),
    },
  };
}

function returnPolicy(p: PublicProduct) {
  if (!p.returnable || p.returnWindowDays <= 0) {
    return {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'IN',
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
    };
  }
  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'IN',
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: p.returnWindowDays,
    returnMethod: 'https://schema.org/ReturnByMail',
  };
}

/** schema.org ProductGroup with one Product (and Offer) per variant. Prices are rupees, not paise. */
export function productJsonLd(p: PublicProduct, siteUrl: string): Record<string, unknown> {
  const url = `${siteUrl}/p/${p.slug}`;
  const optionKeys = [...new Set(p.variants.flatMap((v) => Object.keys(v.options)))];
  const variesBy = optionKeys.flatMap((k) => VARIES_BY[k.toLowerCase()] ?? []);
  const policy = returnPolicy(p);
  return {
    '@context': 'https://schema.org',
    '@type': 'ProductGroup',
    '@id': `${url}#product`,
    productGroupID: p.slug,
    name: p.name,
    description: p.description,
    url,
    brand: { '@type': 'Brand', name: p.brand },
    category: p.category.name,
    ...(p.images.length ? { image: p.images.map(apiAssetUrl) } : {}),
    ...(variesBy.length ? { variesBy } : {}),
    ...(p.rating && p.rating.count > 0
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating.average, ratingCount: p.rating.count, bestRating: 5 } }
      : {}),
    hasVariant: p.variants.map((v) => {
      const variantUrl = `${url}?sku=${encodeURIComponent(v.sku)}`;
      return {
        '@type': 'Product',
        sku: v.sku,
        name: `${p.name} – ${v.title}`,
        url: variantUrl,
        offers: {
          '@type': 'Offer',
          url: variantUrl,
          price: paiseToDecimalString(v.pricePaise),
          priceCurrency: 'INR',
          availability: v.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          itemCondition: 'https://schema.org/NewCondition',
          hasMerchantReturnPolicy: policy,
          shippingDetails: shippingDetails(v.pricePaise),
        },
      };
    }),
  };
}

/** JSON for a `<script type="application/ld+json">`: escapes everything that could end the element. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
