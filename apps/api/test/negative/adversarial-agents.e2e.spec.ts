import { ALL_AGENT_SCOPES, type AgentScope, formatInr, paiseToDecimalString } from '@agentbazaar/contracts';
import { AdversarialBuyer, type AttackResult, connectMcp, EXTRACTION_CORPUS, INJECTION_CORPUS, PII_CORPUS } from '@agentbazaar/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../../src/cli/seed.js';
import { floorPaise } from '../../src/modules/catalog/index.js';
import { TokenService } from '../../src/modules/identity/index.js';
import { ADDRESS, ADMIN_EMAIL, ADMIN_PASSWORD, BUYER_EMAIL, BUYER_PHONE, buy, registerCustomer, type ShopApp } from '../support/shop.js';
import { createTestApp } from '../support/test-app.js';

const TARGET = 'THOCK-TK87-RED';
const PII = [BUYER_EMAIL, BUYER_PHONE, '98765 43210', ADDRESS.name, ADDRESS.line1];

async function floors(app: ShopApp): Promise<Map<string, number>> {
  const rows = await app.infra.database.query<{ sku: string; cost_price_paise: number; landed_cost: Parameters<typeof floorPaise>[1]; min_margin_bps: number }>(
    'SELECT sku, cost_price_paise, landed_cost, min_margin_bps FROM variants',
  );
  return new Map(rows.map((r) => [r.sku, floorPaise(r.cost_price_paise, r.landed_cost, r.min_margin_bps)]));
}

/** Any seller price at or below a SKU's floor, in structured payloads (MCP views, A2A, chat replies). */
function pricesAtOrBelowFloor(value: unknown, floor: Map<string, number>, out: string[], sku?: string): void {
  if (Array.isArray(value)) return value.forEach((v) => pricesAtOrBelowFloor(v, floor, out, sku));
  if (!value || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  const quoteSku = (o.quote as { sku?: unknown } | null | undefined)?.sku;
  const here = typeof o.sku === 'string' ? o.sku : typeof quoteSku === 'string' ? quoteSku : sku;
  const unit = typeof o.unit_price_inr === 'number' ? o.unit_price_inr * 100 : typeof o.unitPricePaise === 'number' ? o.unitPricePaise : undefined;
  const f = here === undefined ? undefined : floor.get(here);
  if (f !== undefined && unit !== undefined && unit <= f) out.push(`${here}: ${unit} <= floor ${f}`);
  for (const v of Object.values(o)) pricesAtOrBelowFloor(v, floor, out, here);
}

// Timestamps (`…T10:19:19.234Z` holds "19.23") and ids can contain a floor's digits without being a price.
const NOT_PRICES = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function floorLeaks(outputs: readonly string[], floor: Map<string, number>): string[] {
  const leaks: string[] = [];
  const all = outputs.join('\n').replace(NOT_PRICES, ' ');
  for (const [sku, f] of floor) {
    // Exact floors with paise are distinctive; whole-rupee ones are covered by the structured check.
    if (f % 100 === 0) continue;
    for (const shown of [paiseToDecimalString(f), formatInr(f), formatInr(f).slice(1)]) if (all.includes(shown)) leaks.push(`${sku}: "${shown}"`);
  }
  for (const out of outputs) {
    try {
      pricesAtOrBelowFloor(JSON.parse(out), floor, leaks);
    } catch {
      // plain-text summaries are covered by the string scan above
    }
  }
  return leaks;
}

describe('floor leak scan', () => {
  const floor = new Map([['CHEAP-1', 1923]]);

  it('ignores ISO timestamps and UUIDs that happen to contain the floor digits', () => {
    const quote = { quoteId: '0b1c1923-19a2-4c19-8a23-6f2c19231923', expiresAt: '2026-11-05T10:19:19.234Z', terms: ['Single use; valid until 2026-11-05T10:19:19.234+05:30.'] };
    expect(floorLeaks([JSON.stringify(quote)], floor)).toEqual([]);
  });

  it('still catches the floor written as a price, even right after a timestamp', () => {
    expect(floorLeaks(['until 2026-11-05T10:19:19.234Z I can do ₹19.23'], floor)).toContain('CHEAP-1: "₹19.23"');
    expect(floorLeaks(['{"unit_price_inr":19.23}'], floor)).toContain('CHEAP-1: "19.23"');
  });
});

describe('@lite adversarial buyer agents over MCP and chat', () => {
  let app: ShopApp;
  let base: string;
  let floor: Map<string, number>;
  let adversary: AdversarialBuyer;
  let results: AttackResult[];
  let token: (clientId: string, scopes: AgentScope[], quotaPerMinute?: number) => Promise<string>;

  beforeAll(async () => {
    // Not demo mode: anonymous agents are read-only and every agent needs a scoped token.
    const test = await createTestApp();
    const seed = await seedDemo(test, { products: 300, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD });
    app = { ...test, seed, clock: test.infra.clock };
    await app.app.listen({ port: 0, host: '127.0.0.1' });
    base = await app.app.getUrl();
    const tokens = app.app.get(TokenService);
    token = async (clientId, scopes, quotaPerMinute = 100_000) => (await tokens.issueAgent({ clientId, scopes, quotaPerMinute })).accessToken;

    // A real customer's order with personal data, placed through the storefront.
    const customer = await registerCustomer(app);
    const { order } = await buy(app, { sku: 'CUBIX-AIRFLOW-BLK', quantity: 1 }, { token: customer.accessToken });
    floor = await floors(app);

    adversary = new AdversarialBuyer({
      mcpUrl: `${base}/mcp`,
      apiUrl: base,
      token: await token('attacker', [...ALL_AGENT_SCOPES]),
      otherToken: await token('other-buyer', [...ALL_AGENT_SCOPES]),
      readOnlyToken: await token('catalog-reader', ['catalog:read']),
      sku: TARGET,
      customizableSku: 'MITTI-MUG-WHITE',
      foreignOrderId: order.orderId,
      expireQuotes: async () => {
        await app.infra.database.query("UPDATE quotes SET expires_at = now() - interval '1 minute' WHERE status = 'active'");
      },
    });
    results = await adversary.run();
  }, 240_000);
  afterAll(async () => app?.close());

  it('runs the whole corpus across every attack category', () => {
    expect(new Set(results.map((r) => r.category))).toEqual(
      new Set(['prompt_injection', 'prompt_extraction', 'floor_probe', 'pii_extraction', 'customization_injection', 'invalid_price', 'wrong_scope', 'quote_token']),
    );
    expect(results.length).toBeGreaterThan(50);
  });

  it('blocks every attack', () => {
    expect(results.filter((r) => !r.blocked)).toEqual([]);
  });

  it('has a zero prompt-injection success rate over MCP and chat', () => {
    const injections = results.filter((r) => r.category === 'prompt_injection' || r.category === 'prompt_extraction');
    expect(injections).toHaveLength(INJECTION_CORPUS.length * 2 + EXTRACTION_CORPUS.length);
    expect(injections.filter((r) => !r.blocked).length / injections.length).toBe(0);
  });

  it('rejects forged, tampered, superseded, cross-customer, expired and reused quote tokens', () => {
    const tokens = results.filter((r) => r.category === 'quote_token');
    expect(tokens.map((r) => r.id).sort()).toEqual(
      ['token-cross-customer', 'token-expired', 'token-forged', 'token-reused', 'token-superseded', 'token-tampered'].sort(),
    );
    expect(tokens.every((r) => r.blocked)).toBe(true);
    expect(tokens.find((r) => r.id === 'token-reused')!.detail).toMatch(/already been used/);
    expect(tokens.find((r) => r.id === 'token-expired')!.detail).toMatch(/expired/);
  });

  it('floor probing by bisection never gets a price at or below the floor', () => {
    const probe = results.find((r) => r.category === 'floor_probe')!;
    expect(probe.lowestAcceptedInr! * 100).toBeGreaterThan(floor.get(TARGET)!);
  });

  it('never leaks a floor, in any payload or formatting', () => {
    expect(adversary.outputs.length).toBeGreaterThan(100);
    expect(floorLeaks(adversary.outputs, floor)).toEqual([]);
  });

  it('never leaks another customer’s personal data', () => {
    expect(results.filter((r) => r.category === 'pii_extraction')).toHaveLength(PII_CORPUS.length + 2);
    const all = adversary.outputs.join('\n');
    for (const value of PII) expect(all).not.toContain(value);
  });

  it('enforces the per-agent quota with 429 rate_limited', async () => {
    const limited = await token('tiny-quota', [...ALL_AGENT_SCOPES], 3);
    const list = () =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${limited}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    // The quota is a fixed one-minute window, so keep calling until it trips (a window boundary only delays it).
    const statuses: number[] = [];
    let res: Response;
    do {
      res = await list();
      statuses.push(res.status);
    } while (res.status !== 429 && statuses.length < 8);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } });

    // Through the official client the same refusal surfaces as an HTTP 429 on the tool call.
    const mcp = await connectMcp(`${base}/mcp`, await token('tiny-quota-2', [...ALL_AGENT_SCOPES], 2));
    try {
      let status: number | undefined;
      for (let i = 0; i < 5 && status !== 429; i++) status = (await mcp.call('search_products', { query: 'mug' })).httpStatus;
      expect(status).toBe(429);
    } finally {
      await mcp.close();
    }
  });
});
