import type { TextFieldSpec } from '@agentbazaar/contracts';
import { prng, type Rng } from './prng.js';
import { heroProducts, r, variant } from './hero-products.js';

export { heroProducts } from './hero-products.js';

export interface SeedCategory {
  path: string;
  name: string;
  nameHi: string;
}

export interface SeedVariant {
  sku: string;
  title: string;
  options: Record<string, string>;
  pricePaise: number;
  mrpPaise: number;
  costPricePaise: number;
  landedCost: { freight: number; paymentFee: number; expectedReturnCost: number; nonRecoverableTax: number };
  minMarginBps: number;
  stock: number;
  supplier: string;
  leadTimeDays: number;
}

export interface SeedProduct {
  slug: string;
  name: string;
  brand: string;
  categoryPath: string;
  description: string;
  hsnCode: string;
  productType: string;
  attributes: Record<string, string | number | boolean>;
  faqs: { q: string; a: string }[];
  returnWindowDays: number;
  customizationSchema: string | null;
  rating: { average: number; count: number } | null;
  variants: SeedVariant[];
}

export interface SeedCustomizationSchema {
  name: string;
  productType: string;
  fields: TextFieldSpec[];
  designRequired: boolean;
  surchargePaise: number;
}

export interface SeedDesign {
  name: string;
  svg: string;
  allowedOn: string[];
}

export interface SeedEdge {
  from: string;
  to: string;
  kind: 'compatible_with' | 'bought_together' | 'alternative_of';
  rule: string | null;
  weight: number;
}

export interface SeedGstRate {
  hsnCode: string;
  rateBps: number;
  effectiveFrom: string;
  description: string;
}

export interface SeedCatalog {
  categories: SeedCategory[];
  products: SeedProduct[];
  customizationSchemas: SeedCustomizationSchema[];
  designs: SeedDesign[];
  edges: SeedEdge[];
  gstRates: SeedGstRate[];
}

export const CATEGORIES: SeedCategory[] = [
  { path: 'electronics', name: 'Electronics', nameHi: 'इलेक्ट्रॉनिक्स' },
  { path: 'electronics.components', name: 'PC Components', nameHi: 'पीसी पार्ट्स' },
  { path: 'electronics.components.gpus', name: 'Graphics Cards', nameHi: 'ग्राफ़िक्स कार्ड' },
  { path: 'electronics.components.psus', name: 'Power Supplies', nameHi: 'पावर सप्लाई' },
  { path: 'electronics.components.cases', name: 'PC Cases', nameHi: 'पीसी केस' },
  { path: 'electronics.accessories', name: 'Accessories', nameHi: 'एक्सेसरीज़' },
  { path: 'electronics.accessories.keyboards', name: 'Keyboards', nameHi: 'कीबोर्ड' },
  { path: 'electronics.accessories.mice', name: 'Mice', nameHi: 'माउस' },
  { path: 'food', name: 'Food & Gourmet', nameHi: 'खाद्य' },
  { path: 'food.chocolates', name: 'Chocolates', nameHi: 'चॉकलेट' },
  { path: 'food.tea', name: 'Tea', nameHi: 'चाय' },
  { path: 'home', name: 'Home & Kitchen', nameHi: 'घर और रसोई' },
  { path: 'home.mugs', name: 'Mugs', nameHi: 'मग' },
  { path: 'apparel', name: 'Apparel', nameHi: 'कपड़े' },
  { path: 'apparel.tshirts', name: 'T-Shirts', nameHi: 'टी-शर्ट' },
  { path: 'stationery', name: 'Stationery', nameHi: 'स्टेशनरी' },
  { path: 'stationery.notebooks', name: 'Notebooks', nameHi: 'नोटबुक' },
];

/** Illustrative GST rates (post Sept-2025 slabs). Operators must confirm current rates with a tax adviser. */
export const GST_RATES: SeedGstRate[] = [
  { hsnCode: '1806', rateBps: 500, effectiveFrom: '2025-09-22', description: 'Chocolate and cocoa preparations' },
  { hsnCode: '0902', rateBps: 500, effectiveFrom: '2025-09-22', description: 'Tea' },
  { hsnCode: '8473', rateBps: 1800, effectiveFrom: '2025-09-22', description: 'Computer parts and accessories' },
  { hsnCode: '8504', rateBps: 1800, effectiveFrom: '2025-09-22', description: 'Power supplies' },
  { hsnCode: '8471', rateBps: 1800, effectiveFrom: '2025-09-22', description: 'Computer input devices' },
  { hsnCode: '6912', rateBps: 500, effectiveFrom: '2025-09-22', description: 'Ceramic tableware' },
  { hsnCode: '6109', rateBps: 500, effectiveFrom: '2025-09-22', description: 'T-shirts (sale value up to ₹2,500)' },
  { hsnCode: '4820', rateBps: 500, effectiveFrom: '2025-09-22', description: 'Notebooks and stationery' },
];

export const CUSTOMIZATION_SCHEMAS: SeedCustomizationSchema[] = [
  {
    name: 'mug-personalisation',
    productType: 'mug',
    fields: [
      { key: 'name', label: 'Name on mug', minLength: 1, maxLength: 20, script: 'latin_devanagari', required: true, allowEmoji: false },
      { key: 'message', label: 'Short message', minLength: 0, maxLength: 40, script: 'latin_devanagari', required: false, allowEmoji: false },
    ],
    designRequired: false,
    surchargePaise: 9900,
  },
  {
    name: 'tshirt-print',
    productType: 'tshirt',
    fields: [
      { key: 'name', label: 'Name on back', minLength: 1, maxLength: 16, script: 'latin', required: true, allowEmoji: false },
      { key: 'tagline', label: 'Tagline', minLength: 0, maxLength: 24, script: 'latin_devanagari', required: false, allowEmoji: false },
    ],
    designRequired: true,
    surchargePaise: 14_900,
  },
  {
    name: 'notebook-initials',
    productType: 'notebook',
    fields: [{ key: 'initials', label: 'Initials', minLength: 1, maxLength: 3, script: 'latin', required: true, allowEmoji: false }],
    designRequired: false,
    surchargePaise: 4900,
  },
];

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

export const DESIGNS: SeedDesign[] = [
  { name: 'Floral Vines', svg: svg('<path d="M10 90 Q50 10 90 90" fill="none" stroke="#2f855a" stroke-width="4"/><circle cx="50" cy="40" r="8" fill="#e53e3e"/>'), allowedOn: ['mug', 'tshirt'] },
  { name: 'Geometric Kolam', svg: svg('<rect x="20" y="20" width="60" height="60" fill="none" stroke="#2b6cb0" stroke-width="4" transform="rotate(45 50 50)"/><circle cx="50" cy="50" r="6" fill="#2b6cb0"/>'), allowedOn: ['mug', 'tshirt'] },
  { name: 'Diwali Diyas', svg: svg('<ellipse cx="50" cy="70" rx="30" ry="10" fill="#c05621"/><path d="M50 30 Q60 50 50 60 Q40 50 50 30" fill="#f6e05e"/>'), allowedOn: ['mug'] },
  { name: 'Cricket Stumps', svg: svg('<rect x="35" y="25" width="6" height="55" fill="#744210"/><rect x="47" y="25" width="6" height="55" fill="#744210"/><rect x="59" y="25" width="6" height="55" fill="#744210"/>'), allowedOn: ['tshirt', 'mug'] },
  { name: 'Mountain Line Art', svg: svg('<polyline points="5,85 35,35 55,65 70,45 95,85" fill="none" stroke="#1a202c" stroke-width="4"/>'), allowedOn: ['tshirt'] },
];

interface Template {
  categoryPath: string;
  productType: string;
  hsnCode: string;
  weight: number;
  brands: string[];
  nouns: string[];
  priceRupees: [number, number];
  axis: { name: string; values: string[] } | null;
  returnWindowDays: number;
  customizationSchema: string | null;
  attributes: (rng: Rng) => Record<string, string | number | boolean>;
  describe: (attrs: Record<string, string | number | boolean>) => string;
}

const TEMPLATES: Template[] = [
  {
    categoryPath: 'electronics.components.gpus', productType: 'gpu', hsnCode: '8473', weight: 6,
    brands: ['Zentrix', 'Novaforge', 'Arcwave'], nouns: ['Graphics Card', 'GPU', 'Gaming Graphics Card'],
    priceRupees: [18_000, 99_000], axis: null, returnWindowDays: 7, customizationSchema: null,
    attributes: (rng) => {
      const mem = rng.pick([8, 12, 16, 24]);
      return { memory_gb: mem, tdp_watts: 120 + mem * 12, recommended_psu_watts: 500 + mem * 20, length_mm: rng.int(240, 340), interface: 'PCIe 5.0' };
    },
    describe: (a) => `Graphics card with ${a.memory_gb} GB memory, ${a.tdp_watts} W board power, ${a.recommended_psu_watts} W recommended power supply and ${a.length_mm} mm length.`,
  },
  {
    categoryPath: 'electronics.components.psus', productType: 'psu', hsnCode: '8504', weight: 6,
    brands: ['VoltEdge', 'Ampora'], nouns: ['Power Supply', 'Modular PSU', 'ATX Power Supply'],
    priceRupees: [3500, 16_000], axis: null, returnWindowDays: 7, customizationSchema: null,
    attributes: (rng) => ({ watts: rng.pick([450, 550, 650, 750, 850, 1000, 1200]), efficiency: rng.pick(['Bronze', 'Gold', 'Platinum']), modular: rng.chance(0.6) }),
    describe: (a) => `${a.watts} W power supply with 80+ ${a.efficiency} efficiency${a.modular ? ' and fully modular cables' : ''}.`,
  },
  {
    categoryPath: 'electronics.components.cases', productType: 'case', hsnCode: '8473', weight: 4,
    brands: ['Cubix', 'Airlane'], nouns: ['Mid Tower Case', 'ATX Case', 'Mesh Cabinet'],
    priceRupees: [2800, 12_000], axis: { name: 'colour', values: ['Black', 'White'] }, returnWindowDays: 7, customizationSchema: null,
    attributes: (rng) => ({ max_gpu_length_mm: rng.int(300, 420), form_factor: 'ATX' }),
    describe: (a) => `ATX cabinet that fits graphics cards up to ${a.max_gpu_length_mm} mm.`,
  },
  {
    categoryPath: 'electronics.accessories.keyboards', productType: 'keyboard', hsnCode: '8471', weight: 8,
    brands: ['Thock', 'Keyvo'], nouns: ['Mechanical Keyboard', 'Wireless Keyboard', 'Gaming Keyboard'],
    priceRupees: [1800, 9000], axis: { name: 'switch', values: ['Red', 'Brown', 'Blue'] }, returnWindowDays: 7, customizationSchema: null,
    attributes: (rng) => ({ layout: rng.pick(['TKL', 'Full', '75%']), hot_swap: rng.chance(0.5) }),
    describe: (a) => `${a.layout} layout keyboard${a.hot_swap ? ' with hot-swappable switches' : ''}.`,
  },
  {
    categoryPath: 'electronics.accessories.mice', productType: 'mouse', hsnCode: '8471', weight: 6,
    brands: ['Glyde', 'Keyvo'], nouns: ['Wireless Mouse', 'Gaming Mouse', 'Ergonomic Mouse'],
    priceRupees: [600, 5000], axis: { name: 'colour', values: ['Black', 'White', 'Grey'] }, returnWindowDays: 7, customizationSchema: null,
    attributes: (rng) => ({ dpi: rng.pick([1600, 4000, 8000, 26_000]), wireless: rng.chance(0.7) }),
    describe: (a) => `${a.wireless ? 'Wireless' : 'Wired'} mouse with up to ${a.dpi} DPI.`,
  },
  {
    categoryPath: 'food.chocolates', productType: 'chocolate', hsnCode: '1806', weight: 14,
    brands: ['Kokoa Craft', 'Cacao Lane', 'Mithas'], nouns: ['Dark Chocolate', 'Milk Chocolate', 'Hazelnut Chocolate', 'Orange Dark Chocolate'],
    priceRupees: [20, 950], axis: { name: 'pack', values: ['Single', 'Pack of 3'] }, returnWindowDays: 0, customizationSchema: null,
    attributes: (rng) => ({ cocoa_percent: rng.pick([32, 45, 55, 70, 85]), weight_g: rng.pick([13, 50, 100, 150]), vegetarian: true }),
    describe: (a) => `${a.weight_g} g chocolate with ${a.cocoa_percent}% cocoa solids. Vegetarian.`,
  },
  {
    categoryPath: 'food.tea', productType: 'tea', hsnCode: '0902', weight: 10,
    brands: ['Pahadi Leaf', 'Chai Kahani'], nouns: ['Assam CTC Tea', 'Darjeeling First Flush', 'Masala Chai Blend', 'Nilgiri Green Tea'],
    priceRupees: [120, 1800], axis: { name: 'pack', values: ['250g', '500g'] }, returnWindowDays: 0, customizationSchema: null,
    attributes: (rng) => ({ origin: rng.pick(['Assam', 'Darjeeling', 'Nilgiris']), caffeine: rng.pick(['High', 'Medium']) }),
    describe: (a) => `Loose leaf tea from ${a.origin} with ${String(a.caffeine).toLowerCase()} caffeine.`,
  },
  {
    categoryPath: 'home.mugs', productType: 'mug', hsnCode: '6912', weight: 12,
    brands: ['Mitti & Co', 'Kumhar'], nouns: ['Ceramic Mug', 'Coffee Mug', 'Stoneware Mug'],
    priceRupees: [249, 899], axis: { name: 'colour', values: ['White', 'Black', 'Teal'] }, returnWindowDays: 7, customizationSchema: 'mug-personalisation',
    attributes: (rng) => ({ capacity_ml: rng.pick([250, 350, 450]), microwave_safe: true }),
    describe: (a) => `${a.capacity_ml} ml ceramic mug, microwave safe. Can be personalised with a name and message.`,
  },
  {
    categoryPath: 'apparel.tshirts', productType: 'tshirt', hsnCode: '6109', weight: 14,
    brands: ['Desi Threads', 'Kurta Lab'], nouns: ['Cotton T-Shirt', 'Oversized T-Shirt', 'Polo T-Shirt'],
    priceRupees: [299, 1499], axis: { name: 'size', values: ['S', 'M', 'L', 'XL'] }, returnWindowDays: 7, customizationSchema: 'tshirt-print',
    attributes: (rng) => ({ fabric: rng.pick(['Cotton', 'Cotton blend']), gsm: rng.pick([160, 180, 220]) }),
    describe: (a) => `${a.gsm} GSM ${String(a.fabric).toLowerCase()} T-shirt. Custom name printing available.`,
  },
  {
    categoryPath: 'stationery.notebooks', productType: 'notebook', hsnCode: '4820', weight: 10,
    brands: ['Kagaz'], nouns: ['Ruled Notebook', 'Dotted Journal', 'Spiral Notebook'],
    priceRupees: [60, 699], axis: { name: 'size', values: ['A5', 'A4'] }, returnWindowDays: 7, customizationSchema: 'notebook-initials',
    attributes: (rng) => ({ pages: rng.pick([100, 160, 200, 300]), paper_gsm: rng.pick([70, 80, 100]) }),
    describe: (a) => `${a.pages} pages of ${a.paper_gsm} GSM paper. Add your initials to the cover.`,
  },
];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const skuPart = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 6) || 'X';

function pickTemplate(rng: Rng): Template {
  const total = TEMPLATES.reduce((a, t) => a + t.weight, 0);
  let roll = rng.next() * total;
  for (const t of TEMPLATES) {
    roll -= t.weight;
    if (roll < 0) return t;
  }
  return TEMPLATES[TEMPLATES.length - 1]!;
}

function generatedProduct(rng: Rng, i: number): SeedProduct {
  const t = pickTemplate(rng);
  const brand = rng.pick(t.brands);
  const noun = rng.pick(t.nouns);
  const model = `${skuPart(brand).slice(0, 2)}${rng.int(100, 999)}`;
  const name = `${brand} ${noun} ${model}`;
  const attributes = t.attributes(rng);
  const basePrice = Math.round(rng.int(t.priceRupees[0], t.priceRupees[1]) / 10) * 10 - 1;
  const base = r(Math.max(t.priceRupees[0], basePrice));
  const returnable = t.returnWindowDays > 0;
  const axisValues = t.axis ? t.axis.values.slice(0, rng.int(1, t.axis.values.length)) : [''];
  const variants = axisValues.map((value, vi) => {
    const price = t.axis?.name === 'pack' && vi > 0 ? Math.round(base * 2.85) : base;
    const outOfStock = rng.chance(0.08);
    return variant(
      `${skuPart(brand)}-${skuPart(t.productType)}-${i.toString(36).toUpperCase()}${value ? `-${skuPart(value)}` : ''}`,
      value ? `${t.axis!.name === 'pack' ? '' : `${t.axis!.name[0]!.toUpperCase()}${t.axis!.name.slice(1)} `}${value}`.trim() : 'Standard',
      value ? { [t.axis!.name]: value } : {},
      price,
      0.55 + rng.next() * 0.23,
      outOfStock ? 0 : rng.int(3, 150),
      returnable,
    );
  });
  return {
    slug: `${slugify(name)}-${i.toString(36)}`,
    name,
    brand,
    categoryPath: t.categoryPath,
    description: t.describe(attributes),
    hsnCode: t.hsnCode,
    productType: t.productType,
    attributes,
    faqs: returnable
      ? [{ q: 'What is the return policy?', a: `Unused items can be returned within ${t.returnWindowDays} days of delivery.` }]
      : [{ q: 'Is this returnable?', a: 'Food items cannot be returned once delivered.' }],
    returnWindowDays: t.returnWindowDays,
    customizationSchema: t.customizationSchema,
    rating: rng.chance(0.9) ? { average: Math.round((3.6 + rng.next() * 1.3) * 10) / 10, count: rng.int(3, 2000) } : null,
    variants,
  };
}

function num(p: SeedProduct, key: string): number {
  const v = p.attributes[key];
  return typeof v === 'number' ? v : 0;
}

/** Compatibility, bought-together and alternative edges computed from real attributes. */
export function computeEdges(products: SeedProduct[], maxPerProduct = 5): SeedEdge[] {
  const by = (type: string) => products.filter((p) => p.productType === type);
  const gpus = by('gpu');
  const psus = by('psu');
  const cases = by('case');
  const edges: SeedEdge[] = [];
  for (const gpu of gpus) {
    const need = num(gpu, 'recommended_psu_watts');
    const fitPsus = psus
      .filter((p) => num(p, 'watts') >= need)
      .sort((a, b) => num(a, 'watts') - num(b, 'watts'))
      .slice(0, maxPerProduct);
    for (const psu of fitPsus) edges.push({ from: gpu.slug, to: psu.slug, kind: 'compatible_with', rule: `psu.watts >= ${need}`, weight: 1 });
    const len = num(gpu, 'length_mm');
    const fitCases = cases
      .filter((c) => num(c, 'max_gpu_length_mm') >= len)
      .sort((a, b) => num(a, 'max_gpu_length_mm') - num(b, 'max_gpu_length_mm'))
      .slice(0, maxPerProduct);
    for (const c of fitCases) edges.push({ from: gpu.slug, to: c.slug, kind: 'compatible_with', rule: `case.max_gpu_length_mm >= ${len}`, weight: 1 });
    if (fitPsus[0]) edges.push({ from: gpu.slug, to: fitPsus[0].slug, kind: 'bought_together', rule: null, weight: 0.8 });
  }
  const pairs: [string, string][] = [
    ['keyboard', 'mouse'],
    ['mug', 'chocolate'],
    ['tshirt', 'mug'],
    ['notebook', 'tea'],
  ];
  for (const [a, b] of pairs) {
    const left = by(a).slice(0, 200);
    const right = by(b);
    left.forEach((p, i) => {
      const other = right[i % Math.max(1, right.length)];
      if (other) edges.push({ from: p.slug, to: other.slug, kind: 'bought_together', rule: null, weight: 0.5 });
    });
  }
  for (const type of new Set(products.map((p) => p.productType))) {
    const group = by(type).sort((a, b) => a.variants[0]!.pricePaise - b.variants[0]!.pricePaise);
    group.slice(0, 400).forEach((p, i) => {
      const alt = group[i + 1];
      if (alt && alt.variants[0]!.pricePaise <= p.variants[0]!.pricePaise * 1.2) {
        edges.push({ from: p.slug, to: alt.slug, kind: 'alternative_of', rule: 'same category, price within 20%', weight: 0.6 });
      }
    });
  }
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (e.from === e.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Deterministic catalog: the hero products plus `products - heroes` generated ones. */
export function generateCatalog(opts: { products?: number; seed?: number } = {}): SeedCatalog {
  const rng = prng(opts.seed ?? 20_261_105);
  const heroes = heroProducts();
  const total = Math.max(heroes.length, opts.products ?? 300);
  const products = [...heroes];
  for (let i = heroes.length; i < total; i++) products.push(generatedProduct(rng, i));
  return {
    categories: CATEGORIES,
    products,
    customizationSchemas: CUSTOMIZATION_SCHEMAS,
    designs: DESIGNS,
    edges: computeEdges(products),
    gstRates: GST_RATES,
  };
}
