// k6 load test for the lite profile (plan targets: ~30 mixed RPS, 100 sessions, 2 checkouts/s;
// read p95 < 300 ms, checkout p95 < 800 ms, errors < 0.1%).
//   k6 run -e BASE_URL=http://localhost:4000 tests/load/lite.js
//   Soak: k6 run -e DURATION=8h -e BASE_URL=... tests/load/lite.js (raise stock first, see docs/benchmarks/lite.md)
import http from 'k6/http';
import { check, group } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const DURATION = __ENV.DURATION || '3m';
const readLatency = new Trend('read_latency', true);
const checkoutLatency = new Trend('checkout_latency', true);

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      rate: 28,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 60,
      maxVUs: 100,
      exec: 'browse',
    },
    checkout: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 60,
      exec: 'checkout',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    read_latency: ['p(95)<300'],
    checkout_latency: ['p(95)<800'],
  },
};

const QUERIES = [
  'keyboard',
  'gpu 12gb',
  'dark chocolate',
  'mug',
  'power supply 850w',
  'tshirt',
  'tea',
  'keybaord',
  'notebook',
];
const SKUS = [
  'THOCK-TK87-RED',
  'THOCK-TK87-BROWN',
  'VOLTEDGE-850G',
  'CUBIX-AIRFLOW-BLK',
  'MITTI-MUG-WHITE',
  'KOKOA-MINI-13G',
];
const json = { headers: { 'content-type': 'application/json' } };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
// The availability API shows at most this many units, so a SKU showing it has at least that many on hand.
const DISPLAY_CAP = 50;
const CHECKOUT_SKUS_MAX = 40;

/**
 * Finds well-stocked SKUs to buy, so checkouts spread over many variants instead of draining one
 * (KOKOA-MINI-13G alone has 500 units, about four minutes at 2 orders/s).
 */
export function setup() {
  const candidates = ['KOKOA-MINI-13G'];
  for (let offset = 0; offset < 500 && candidates.length < CHECKOUT_SKUS_MAX * 2; offset += 50) {
    const res = http.get(`${BASE}/api/v1/products?inStockOnly=true&limit=50&offset=${offset}`, {
      tags: { name: 'setup' },
    });
    const items = res.status === 200 ? res.json('items') : [];
    // Premium items have a handful of units; customizable ones need personalisation before checkout.
    for (const p of items) {
      if (!p.customizable && p.band !== 'premium' && !candidates.includes(p.defaultSku)) {
        candidates.push(p.defaultSku);
      }
    }
    if (items.length < 50) break;
  }
  const skus = [];
  for (const sku of candidates) {
    if (skus.length >= CHECKOUT_SKUS_MAX) break;
    const a = http.get(`${BASE}/api/v1/availability/${encodeURIComponent(sku)}?quantity=1`, {
      tags: { name: 'setup' },
    });
    if (a.status === 200 && a.json('availableQty') >= DISPLAY_CAP) skus.push(sku);
  }
  if (!skus.length) throw new Error(`No SKU with ${DISPLAY_CAP}+ units at ${BASE}; seed the catalog first`);
  console.log(`checkout spreads over ${skus.length} SKUs: ${skus.join(', ')}`);
  return { skus };
}

export function browse() {
  group('read', () => {
    const r = Math.random();
    let res;
    if (r < 0.5)
      res = http.get(`${BASE}/api/v1/products?q=${encodeURIComponent(pick(QUERIES))}&limit=12`, {
        tags: { name: 'search' },
      });
    else if (r < 0.8)
      res = http.get(`${BASE}/api/v1/products/thock-tk87-mechanical-keyboard`, { tags: { name: 'product' } });
    else if (r < 0.95)
      res = http.get(`${BASE}/api/v1/availability/${pick(SKUS)}?quantity=1`, {
        tags: { name: 'availability' },
      });
    else res = http.get(`${BASE}/api/v1/categories`, { tags: { name: 'categories' } });
    readLatency.add(res.timings.duration);
    check(res, { 'read 200': (x) => x.status === 200 });
  });
}

export function checkout(data) {
  group('checkout', () => {
    const cart = http.post(`${BASE}/api/v1/carts`, '{}', json);
    if (!check(cart, { 'cart 201': (x) => x.status === 201 })) return;
    const cartId = cart.json('cartId');
    http.post(
      `${BASE}/api/v1/carts/${cartId}/lines`,
      JSON.stringify({ sku: pick(data.skus), quantity: 1 }),
      json,
    );
    const key = `k6-${__VU}-${__ITER}-${Date.now()}`;
    const t0 = Date.now();
    const session = http.post(`${BASE}/api/v1/checkout/sessions`, JSON.stringify({ cartId }), {
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
    });
    if (!check(session, { 'session 201': (x) => x.status === 201 })) return;
    const done = http.post(
      `${BASE}/api/v1/checkout/sessions/${session.json('sessionId')}/complete?t=${encodeURIComponent(session.json('token'))}`,
      JSON.stringify({
        email: `load+${__VU}-${__ITER}@example.com`,
        address: {
          name: 'Load Test',
          phone: '9876543210',
          line1: '1 Test Street',
          city: 'Delhi',
          stateCode: 'DL',
          pincode: '110001',
        },
        paymentMethod: 'cod',
        acceptTerms: true,
      }),
      { headers: { 'content-type': 'application/json', 'idempotency-key': `${key}-c` } },
    );
    checkoutLatency.add(Date.now() - t0);
    check(done, { 'order 201': (x) => x.status === 201 });
  });
}
