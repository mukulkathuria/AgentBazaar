// k6 load test for the scale profile (plan: 5,000 shopper sessions plus 500 agent sessions, about 1,500 mixed RPS,
// a 50 orders/s flash-sale spike; read p95 < 300 ms, checkout p95 < 800 ms, errors < 0.1%, and the same targets met
// again within 5 minutes of the spike, i.e. autoscaling has recovered). Steps, cost and pass criteria:
// docs/runbooks/scale-load-and-zone-drill.md.
//   Full run:   k6 run -e BASE_URL=https://api.shop.example.com -e AGENT_TOKENS=tok1,tok2,... tests/load/scale.js
//   Smoke (1%): k6 run -e BASE_URL=http://localhost:4000 -e SCALE=0.01 -e DURATION=4m -e SPIKE_AT=60s \
//                 -e SPIKE_FOR=30s -e RECOVERY=60s tests/load/scale.js
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import exec from 'k6/execution';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const SCALE = Number(__ENV.SCALE || 1);
const seconds = (d) => {
  const m = /^(\d+)(s|m|h)$/.exec(d);
  if (!m) throw new Error(`Durations look like 90s, 15m or 1h, not ${d}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
};
const DURATION = seconds(__ENV.DURATION || '15m');
const SPIKE_AT = seconds(__ENV.SPIKE_AT || '4m');
const SPIKE_FOR = seconds(__ENV.SPIKE_FOR || '2m');
const RECOVERY = seconds(__ENV.RECOVERY || '5m');
const RECOVERED_FROM = SPIKE_AT + SPIKE_FOR + RECOVERY;
if (RECOVERED_FROM + 60 > DURATION) throw new Error('DURATION must leave a minute after SPIKE_AT + SPIKE_FOR + RECOVERY');

const at = (n) => Math.max(1, Math.round(n * SCALE));
const SHOPPERS = at(5000);
const AGENTS = at(500);
// Arrival rates per minute, so a 1% smoke still gets whole numbers.
const BASE_ORDERS_PER_MIN = at(10 * 60);
const PEAK_ORDERS_PER_MIN = at(50 * 60);
const TOKENS = (__ENV.AGENT_TOKENS || '').split(',').filter(Boolean);

const readLatency = new Trend('read_latency', true);
const checkoutLatency = new Trend('checkout_latency', true);
const agentLatency = new Trend('agent_latency', true);
// Reads once the post-spike recovery window has passed: the "recovers within 5 minutes" criterion.
const recoveredReadLatency = new Trend('recovered_read_latency', true);

export const options = {
  scenarios: {
    // 5,000 sessions, each a request every 3-5 s: about 1,250 reads/s.
    shoppers: { executor: 'constant-vus', vus: SHOPPERS, duration: `${DURATION}s`, exec: 'shop' },
    // 500 agent sessions, each search -> quote -> offer then a pause: about 250 MCP calls/s.
    agents: { executor: 'constant-vus', vus: AGENTS, duration: `${DURATION}s`, exec: 'agent' },
    // Steady orders, 10/s.
    orders: {
      executor: 'constant-arrival-rate',
      rate: BASE_ORDERS_PER_MIN,
      timeUnit: '1m',
      duration: `${DURATION}s`,
      preAllocatedVUs: at(60),
      maxVUs: at(300),
      exec: 'checkout',
    },
    // The flash sale: up to 50 orders/s for SPIKE_FOR, ramping over 30 s each way.
    flash_sale: {
      executor: 'ramping-arrival-rate',
      startTime: `${SPIKE_AT}s`,
      startRate: 0,
      timeUnit: '1m',
      stages: [
        { target: PEAK_ORDERS_PER_MIN, duration: '30s' },
        { target: PEAK_ORDERS_PER_MIN, duration: `${Math.max(1, SPIKE_FOR - 60)}s` },
        { target: 0, duration: '30s' },
      ],
      preAllocatedVUs: at(200),
      maxVUs: at(1500),
      exec: 'checkout',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    read_latency: ['p(95)<300'],
    checkout_latency: ['p(95)<800'],
    agent_latency: ['p(95)<800'],
    recovered_read_latency: ['p(95)<300'],
    'http_req_failed{phase:recovered}': ['rate<0.001'],
  },
};

const QUERIES = ['keyboard', 'gpu 12gb', 'dark chocolate', 'mug', 'power supply 850w', 'tshirt', 'tea', 'keybaord', 'notebook'];
const SKUS = ['THOCK-TK87-RED', 'THOCK-TK87-BROWN', 'VOLTEDGE-850G', 'CUBIX-AIRFLOW-BLK', 'MITTI-MUG-WHITE', 'KOKOA-MINI-13G'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const DISPLAY_CAP = 50;
const phase = () => {
  const s = exec.instance.currentTestRunDuration / 1000;
  if (s < SPIKE_AT) return 'steady';
  if (s < SPIKE_AT + SPIKE_FOR) return 'spike';
  return s < RECOVERED_FROM ? 'recovering' : 'recovered';
};

/** Well-stocked, plain SKUs for the orders (the flash sale alone needs about 6,000 units at full scale). */
export function setup() {
  const skus = [];
  for (let offset = 0; offset < 1000 && skus.length < 60; offset += 50) {
    const res = http.get(`${BASE}/api/v1/products?inStockOnly=true&limit=50&offset=${offset}`, { tags: { name: 'setup' } });
    const items = res.status === 200 ? res.json('items') : [];
    for (const p of items) {
      if (p.customizable || p.band === 'premium') continue;
      const a = http.get(`${BASE}/api/v1/availability/${encodeURIComponent(p.defaultSku)}?quantity=1`, { tags: { name: 'setup' } });
      if (a.status === 200 && a.json('availableQty') >= DISPLAY_CAP) skus.push(p.defaultSku);
    }
    if (items.length < 50) break;
  }
  if (!skus.length) throw new Error(`No SKU with ${DISPLAY_CAP}+ units at ${BASE}; raise stock first (see the runbook)`);
  console.log(`orders spread over ${skus.length} SKUs; ${SHOPPERS} shoppers, ${AGENTS} agents, SCALE=${SCALE}`);
  return { skus };
}

export function shop() {
  group('read', () => {
    const tags = { phase: phase() };
    const r = Math.random();
    let res;
    if (r < 0.5) res = http.get(`${BASE}/api/v1/products?q=${encodeURIComponent(pick(QUERIES))}&limit=12`, { tags: { ...tags, name: 'search' } });
    else if (r < 0.8) res = http.get(`${BASE}/api/v1/products/thock-tk87-mechanical-keyboard`, { tags: { ...tags, name: 'product' } });
    else if (r < 0.95) res = http.get(`${BASE}/api/v1/availability/${pick(SKUS)}?quantity=1`, { tags: { ...tags, name: 'availability' } });
    else res = http.get(`${BASE}/api/v1/categories`, { tags: { ...tags, name: 'categories' } });
    readLatency.add(res.timings.duration);
    if (tags.phase === 'recovered') recoveredReadLatency.add(res.timings.duration);
    check(res, { 'read 200': (x) => x.status === 200 });
  });
  sleep(3 + Math.random() * 2);
}

function mcp(name, args, tags) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (TOKENS.length) headers.authorization = `Bearer ${TOKENS[__VU % TOKENS.length]}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const res = http.post(`${BASE}/mcp`, body, { headers, tags: { ...tags, name: `mcp ${name}` } });
  agentLatency.add(res.timings.duration);
  check(res, { 'mcp 200': (x) => x.status === 200 && !String(x.body).includes('"isError":true') });
  return String(res.body);
}

export function agent() {
  group('agent', () => {
    const tags = { phase: phase() };
    mcp('search_products', { query: pick(QUERIES), limit: 5 }, tags);
    const quote = mcp('request_quote', { sku: pick(SKUS), quantity: 1 }, tags);
    const nid = /negotiation_id[\\"=: ]+([0-9a-f]{8}-[0-9a-f-]{27})/.exec(quote);
    const unit = /unit_price_inr[\\": ]+(\d+)/.exec(quote);
    if (nid && unit) mcp('make_offer', { negotiation_id: nid[1], unit_price_inr: Math.floor(Number(unit[1]) * 0.9) }, tags);
  });
  sleep(4 + Math.random() * 2);
}

export function checkout(data) {
  group('checkout', () => {
    const tags = { phase: phase() };
    const json = { headers: { 'content-type': 'application/json' }, tags };
    const cart = http.post(`${BASE}/api/v1/carts`, '{}', json);
    if (!check(cart, { 'cart 201': (x) => x.status === 201 })) return;
    const cartId = cart.json('cartId');
    http.post(`${BASE}/api/v1/carts/${cartId}/lines`, JSON.stringify({ sku: pick(data.skus), quantity: 1 }), json);
    const key = `k6-scale-${__VU}-${__ITER}-${Date.now()}`;
    const t0 = Date.now();
    const session = http.post(`${BASE}/api/v1/checkout/sessions`, JSON.stringify({ cartId }), {
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      tags,
    });
    if (!check(session, { 'session 201': (x) => x.status === 201 })) return;
    const done = http.post(
      `${BASE}/api/v1/checkout/sessions/${session.json('sessionId')}/complete?t=${encodeURIComponent(session.json('token'))}`,
      JSON.stringify({
        email: `load+${__VU}-${__ITER}@example.com`,
        address: { name: 'Load Test', phone: '9876543210', line1: '1 Test Street', city: 'Delhi', stateCode: 'DL', pincode: '110001' },
        paymentMethod: 'cod',
        acceptTerms: true,
      }),
      { headers: { 'content-type': 'application/json', 'idempotency-key': `${key}-c` }, tags },
    );
    checkoutLatency.add(Date.now() - t0);
    check(done, { 'order 201': (x) => x.status === 201 });
  });
}
