import { type ChatConversation, type ChatPlan, type FakeLlmUsage, prng, runChatConversation, startFakeLlm } from '@agentbazaar/testkit';
import { describe, expect, it } from 'vitest';
import { seedDemo } from '../../src/cli/seed.js';
import { floorPaise } from '../../src/modules/catalog/index.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, call, type ShopApp } from '../support/shop.js';
import { createTestApp } from '../support/test-app.js';

/**
 * G5 cost evaluation (docs/benchmarks/ai-cost.md). The same scripted conversations run twice through
 * the chat API with a deterministic fake model that reports token usage:
 *   baseline:  ROUTER_SHADOW_MODE, so every turn uses the large model and the observer checks every turn;
 *   optimised: routed tiers, the semantic cache and the gated observer.
 * Cost comes from the API's own accounting (DEFAULT_PRICES); conversion proxies come from the replies.
 */
const CONVERSATIONS = 40;
const PRODUCTS = [
  { sku: 'THOCK-TK87-RED', query: 'mechanical keyboard' },
  { sku: 'THOCK-TK87-BROWN', query: 'mechanical keyboard' },
  { sku: 'VOLTEDGE-850G', query: 'power supply' },
  { sku: 'CUBIX-AIRFLOW-BLK', query: 'pc case' },
  { sku: 'VOLTEDGE-1000P', query: 'power supply' },
] as const;

/** 60% buy after haggling, 20% browse, 20% attack; one conversation in three in Hindi. */
const PLANS: ChatPlan[] = Array.from({ length: CONVERSATIONS }, (_, i) => ({
  ...PRODUCTS[i % PRODUCTS.length]!,
  kind: i % 5 === 4 ? 'adversarial' : i % 5 === 3 ? 'browse' : 'deal',
  language: i % 3 === 2 ? 'hi' : 'en',
}));

interface Arm {
  name: string;
  costMicroInrPerConversation: number;
  tokensPerConversation: number;
  modelCallsPerConversation: number;
  judgeCalls: number;
  cacheHits: number;
  byKindAndModel: Record<string, { calls: number; costMicroInr: number }>;
  deals: number;
  checkoutLinks: number;
  floorViolations: number;
  usage: FakeLlmUsage;
}

async function floors(app: ShopApp): Promise<Map<string, number>> {
  const rows = await app.infra.database.query<{ sku: string; cost_price_paise: number; landed_cost: Parameters<typeof floorPaise>[1]; min_margin_bps: number }>(
    'SELECT sku, cost_price_paise, landed_cost, min_margin_bps FROM variants',
  );
  return new Map(rows.map((r) => [r.sku, floorPaise(r.cost_price_paise, r.landed_cost, r.min_margin_bps)]));
}

/** Any seller quote at or below the SKU's floor, in any turn of any conversation. */
const violations = (conversations: readonly ChatConversation[], floor: Map<string, number>): number =>
  conversations
    .flatMap((c) => c.turns)
    .filter(({ reply }) => {
      const q = reply.negotiation?.quote;
      return q !== null && q !== undefined && q.unitPricePaise <= (floor.get(q.sku) ?? 0);
    }).length;

async function runArm(name: string, env: Record<string, string>): Promise<Arm> {
  const llm = await startFakeLlm();
  const app = await createTestApp(
    { DEMO_MODE: 'true', LLM_ADAPTER: 'openai-compatible', OPENAI_COMPAT_BASE_URL: llm.url, ...env },
    { clock: new ManualClock() },
  );
  try {
    await seedDemo(app, { products: 60, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD });
    const shop = app as ShopApp;
    const post = async (path: string, body: unknown) => {
      const res = await call(shop, 'POST', path, { body });
      if (res.statusCode >= 300) throw new Error(`${path} answered HTTP ${res.statusCode}: ${res.body}`);
      return res.json<Record<string, unknown>>();
    };
    const conversations: ChatConversation[] = [];
    for (const [i, plan] of PLANS.entries()) conversations.push(await runChatConversation(post, plan, prng(1000 + i)));

    const [spend] = await app.infra.database.query<{ cost: string; tokens: string }>(
      'SELECT sum(cost_micro_inr)::text AS cost, sum(tokens_used)::text AS tokens FROM chat_sessions',
    );
    const traces = await app.infra.database.query<{ kind: string; model: string; calls: string; cost: string }>(
      'SELECT kind, model, count(*)::text AS calls, sum(cost_micro_inr)::text AS cost FROM llm_traces GROUP BY kind, model ORDER BY kind, model',
    );
    const usage = llm.usage();
    return {
      name,
      costMicroInrPerConversation: Number(spend!.cost) / CONVERSATIONS,
      tokensPerConversation: Number(spend!.tokens) / CONVERSATIONS,
      modelCallsPerConversation: usage.calls / CONVERSATIONS,
      judgeCalls: usage.judgeCalls,
      cacheHits: traces.filter((t) => t.kind === 'cache').reduce((n, t) => n + Number(t.calls), 0),
      byKindAndModel: Object.fromEntries(traces.map((t) => [`${t.kind}/${t.model}`, { calls: Number(t.calls), costMicroInr: Number(t.cost) }])),
      deals: conversations.filter((c) => c.deal).length,
      checkoutLinks: conversations.filter((c) => c.checkoutUrl !== null).length,
      floorViolations: violations(conversations, await floors(shop)),
      usage,
    };
  } finally {
    await app.close();
    await llm.close();
  }
}

const rupees = (microInr: number) => `₹${(microInr / 1e6).toFixed(4)}`;

describe('@growth G5 cost evaluation: routed tiers, semantic cache and observer gating against the all-large-model shadow baseline', () => {
  it('costs less per conversation with no drop in conversion proxies', async () => {
    const baseline = await runArm('shadow baseline (all large model, observer on every turn)', { ROUTER_SHADOW_MODE: 'true', SEMANTIC_CACHE: 'off' });
    // Not asserted: shows how much routing and gating save before the cache is added.
    const routedOnly = await runArm('routed tiers + gated observer, cache off', { SEMANTIC_CACHE: 'off' });
    const optimised = await runArm('routed tiers + semantic cache + gated observer', { SEMANTIC_CACHE: 'memory' });

    const rows = [baseline, routedOnly, optimised].map(
      (a) =>
        `| ${a.name} | ${rupees(a.costMicroInrPerConversation)} | ${a.tokensPerConversation.toFixed(0)} | ${a.modelCallsPerConversation.toFixed(2)} | ` +
        `${a.judgeCalls} | ${a.cacheHits} | ${a.deals}/${CONVERSATIONS} | ${a.checkoutLinks}/${CONVERSATIONS} | ${a.floorViolations} |`,
    );
    const saving = 1 - optimised.costMicroInrPerConversation / baseline.costMicroInrPerConversation;
    console.warn(
      [
        `AI cost evaluation, ${CONVERSATIONS} conversations per arm (${PLANS.filter((p) => p.language === 'hi').length} in Hindi, ` +
          `${PLANS.filter((p) => p.kind === 'adversarial').length} adversarial):`,
        '| Arm | Cost per conversation | Tokens per conversation | Model calls per conversation | Judge calls | Cache hits | Deals | Checkout links | Floor violations |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        `Saving per conversation: ${(saving * 100).toFixed(1)}%`,
        `Calls and cost by kind/model: ${JSON.stringify({ baseline: baseline.byKindAndModel, routedOnly: routedOnly.byKindAndModel, optimised: optimised.byKindAndModel })}`,
      ].join('\n'),
    );

    expect(optimised.costMicroInrPerConversation).toBeLessThan(baseline.costMicroInrPerConversation);
    expect(optimised.deals).toBeGreaterThanOrEqual(baseline.deals);
    expect(optimised.checkoutLinks).toBeGreaterThanOrEqual(baseline.checkoutLinks);
    expect(baseline.floorViolations).toBe(0);
    expect(optimised.floorViolations).toBe(0);
    expect(optimised.deals).toBeGreaterThan(0);
    expect(optimised.cacheHits).toBeGreaterThan(0);
  }, 300_000);
});
