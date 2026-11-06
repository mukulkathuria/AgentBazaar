// k6 agent traffic spike (S6): buyer agents search, quote and haggle over MCP, then haggle in chat, where
// replies go through the model router, the semantic cache and the gated observer. Budgets: tool and chat
// latency (p95), errors, and model cost per agent conversation from the API's own token counters.
//   node packages/testkit/dist/bin/fake-llm.js --port 4117 --latency-ms 50
//   (API on 4107 with LLM_ADAPTER=openai-compatible, OPENAI_COMPAT_BASE_URL=http://127.0.0.1:4117/v1)
//   k6 run -e BASE_URL=http://127.0.0.1:4107 tests/load/agent-spike.js
// See docs/benchmarks/agent-spike.md for the full setup and the measured results.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:4107';
// Agent conversations started per second. The defaults are a 5x spike that one API process on embedded
// PGlite handles within budget; 2 -> 10 saturates it (docs/benchmarks/agent-spike.md).
const BASELINE = Number(__ENV.BASELINE_RATE || 1);
const PEAK = Number(__ENV.PEAK_RATE || 5);
// Budget per agent conversation (two chat turns; MCP tool calls run no model). The session cap is ₹5.
const COST_BUDGET_INR = Number(__ENV.COST_BUDGET_INR || 0.5);

// Micro-rupees per 1,000 tokens: DEFAULT_PRICES in apps/api/src/modules/agent/domain/budget.ts. The router
// sends tier 2 to LLM_SMALL_MODEL and tier 3 and the observer's judge to LLM_LARGE_MODEL.
const PRICES = {
  small: { in: 8_800, out: 44_000 }, // claude-haiku-5-5
  large: { in: 176_000, out: 880_000 }, // claude-sonnet-5-5
};

const toolLatency = new Trend('tool_latency', true);
const chatLatency = new Trend('chat_turn_latency', true);
const conversations = new Counter('agent_conversations');

export const options = {
  scenarios: {
    agents: {
      executor: 'ramping-arrival-rate',
      startRate: BASELINE,
      timeUnit: '1s',
      preAllocatedVUs: 40,
      maxVUs: 200,
      stages: [
        { target: BASELINE, duration: '20s' }, // steady agent traffic
        { target: PEAK, duration: '10s' }, // the spike
        { target: PEAK, duration: '30s' },
        { target: BASELINE, duration: '10s' }, // and back
        { target: BASELINE, duration: '20s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'tool_latency{tool:search_products}': ['p(95)<300'],
    'tool_latency{tool:request_quote}': ['p(95)<800'],
    'tool_latency{tool:make_offer}': ['p(95)<800'],
    chat_turn_latency: ['p(95)<1000'],
  },
};

const PRODUCTS = [
  { sku: 'THOCK-TK87-RED', query: 'mechanical keyboard' },
  { sku: 'THOCK-TK87-BROWN', query: 'mechanical keyboard' },
  { sku: 'VOLTEDGE-850G', query: 'power supply' },
  { sku: 'CUBIX-AIRFLOW-BLK', query: 'pc case' },
  { sku: 'VOLTEDGE-1000P', query: 'power supply' },
];
const JSON_HEADERS = { 'content-type': 'application/json' };
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function tool(name, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const res = http.post(`${BASE}/mcp`, body, { headers: MCP_HEADERS, tags: { name: `mcp ${name}` } });
  toolLatency.add(res.timings.duration, { tool: name });
  const result = res.status === 200 ? res.json('result') : null;
  check(res, { [`${name} ok`]: () => result !== null && result.isError !== true });
  return result ? result.structuredContent : null;
}

function say(sessionId, text) {
  const res = http.post(`${BASE}/api/v1/chat/sessions/${sessionId}/messages`, JSON.stringify({ text }), {
    headers: JSON_HEADERS,
    tags: { name: 'chat turn' },
  });
  chatLatency.add(res.timings.duration);
  check(res, { 'chat turn 200': (r) => r.status === 200 });
  return res.status === 200 ? res.json() : null;
}

/** Counters from the API's Prometheus endpoint, keyed by metric name and labels. */
function scrape() {
  const res = http.get(`${BASE}/metrics`, { tags: { name: 'metrics' } });
  if (res.status !== 200) fail(`GET /metrics answered ${res.status}`);
  const counters = {};
  for (const line of res.body.split('\n')) {
    const m = /^(agentbazaar_[a-z_]+)(\{[^}]*\})?\s+(\S+)$/.exec(line);
    if (m) counters[`${m[1]}${m[2] || ''}`] = Number(m[3]);
  }
  return counters;
}

export function setup() {
  const ready = http.get(`${BASE}/readyz`);
  if (ready.status !== 200) fail(`API at ${BASE} is not ready (${ready.status})`);
  return scrape();
}

export default function () {
  const product = pick(PRODUCTS);
  conversations.add(1);
  tool('search_products', { query: product.query, limit: 5, in_stock_only: true });
  const quote = tool('request_quote', { sku: product.sku, quantity: 1 });
  const list = quote && quote.quote ? quote.quote.list_unit_price_inr : null;
  if (list)
    tool('make_offer', { negotiation_id: quote.negotiation_id, unit_price_inr: Math.round(list * 0.85) });

  const session = http.post(`${BASE}/api/v1/chat/sessions`, JSON.stringify({ language: 'en' }), {
    headers: JSON_HEADERS,
    tags: { name: 'chat session' },
  });
  if (!check(session, { 'chat session 201': (r) => r.status === 201 })) return;
  const id = session.json('sessionId');
  const priced = say(id, `how much is ${product.sku}?`);
  const ask =
    priced && priced.negotiation && priced.negotiation.quote
      ? priced.negotiation.quote.unitPricePaise / 100
      : null;
  if (ask) say(id, `can you do ${Math.round(ask * 0.85)}?`);
}

export function teardown(before) {
  const after = scrape();
  const delta = (key) => (after[key] || 0) - (before[key] || 0);
  const tokens = (tier, direction) =>
    delta(`agentbazaar_llm_tokens_total{tier="${tier}",direction="${direction}"}`);
  const sessions = delta(
    'agentbazaar_http_request_duration_seconds_count{method="POST",route="/api/v1/chat/sessions",status="201"}',
  );
  const microInr =
    (tokens('2', 'in') * PRICES.small.in +
      tokens('2', 'out') * PRICES.small.out +
      (tokens('3', 'in') + tokens('observer', 'in')) * PRICES.large.in +
      (tokens('3', 'out') + tokens('observer', 'out')) * PRICES.large.out) /
    1000;
  const perConversation = sessions ? microInr / sessions / 1e6 : 0;
  const cache = (outcome) => delta(`agentbazaar_semantic_cache_total{outcome="${outcome}"}`);
  const observer = (decision) => delta(`agentbazaar_observer_turns_total{decision="${decision}"}`);
  console.log(
    JSON.stringify({
      conversations: sessions,
      model_cost_inr_total: +(microInr / 1e6).toFixed(4),
      model_cost_inr_per_conversation: +perConversation.toFixed(4),
      tokens: {
        tier2_in: tokens('2', 'in'),
        tier2_out: tokens('2', 'out'),
        tier3_in: tokens('3', 'in'),
        tier3_out: tokens('3', 'out'),
        judge_in: tokens('observer', 'in'),
        judge_out: tokens('observer', 'out'),
      },
      semantic_cache: {
        hit: cache('hit'),
        miss: cache('miss'),
        rejected: cache('rejected'),
        stored: cache('stored'),
        skipped: cache('skipped'),
      },
      observer: {
        observed: observer('observed'),
        skipped: observer('skipped'),
        replaced: observer('replaced'),
      },
    }),
  );
  if (!sessions) fail('no chat sessions were created');
  if (perConversation > COST_BUDGET_INR)
    fail(`model cost ₹${perConversation.toFixed(4)} per conversation is over the ₹${COST_BUDGET_INR} budget`);
}
