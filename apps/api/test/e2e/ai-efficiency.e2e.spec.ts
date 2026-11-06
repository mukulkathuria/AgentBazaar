import { type ChatReply, formatInr } from '@agentbazaar/contracts';
import { type FakeLlm, INJECTION_CORPUS, PII_CORPUS, startFakeLlm } from '@agentbazaar/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../../src/cli/seed.js';
import { ManualClock } from '../../src/shared/kernel/clock.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, call, ok, type ShopApp } from '../support/shop.js';
import { createTestApp } from '../support/test-app.js';

// A fixed clock keeps quote expiry times, which are numbers in the templates, equal for every buyer.
async function chatApp(env: Record<string, string>): Promise<ShopApp> {
  const clock = new ManualClock();
  const app = await createTestApp({ DEMO_MODE: 'true', ...env }, { clock });
  const seed = await seedDemo(app, { products: 60, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD });
  return { ...app, seed, clock };
}

const start = async (app: ShopApp) => ok<{ sessionId: string }>(await call(app, 'POST', '/api/v1/chat/sessions', { body: { language: 'en' } }), 201).sessionId;
const say = async (app: ShopApp, sessionId: string, text: string) =>
  ok<ChatReply>(await call(app, 'POST', `/api/v1/chat/sessions/${sessionId}/messages`, { body: { text } }), 200);
const kinds = async (app: ShopApp, sessionId: string) =>
  (await app.infra.database.query<{ kind: string }>('SELECT kind FROM llm_traces WHERE session_id = $1 ORDER BY id', [sessionId])).map((r) => r.kind);
const observed = async (app: ShopApp, sessionId: string) =>
  (
    await app.infra.database.query<{ data: { reasons: string[]; judge: boolean } }>(
      "SELECT data FROM audit_log WHERE action = 'chat.observed' AND target = $1 ORDER BY id",
      [sessionId],
    )
  ).map((r) => r.data);

describe('@growth semantic cache and gated observer through the chat flow', () => {
  let llm: FakeLlm;
  let app: ShopApp;
  beforeAll(async () => {
    llm = await startFakeLlm();
    app = await chatApp({ LLM_ADAPTER: 'openai-compatible', OPENAI_COMPAT_BASE_URL: llm.url, SEMANTIC_CACHE: 'memory' });
  });
  afterAll(async () => {
    await app.close();
    await llm.close();
  });

  it("answers a second customer from the cache with that customer's own prices, and the judge still checks it", async () => {
    const a = await start(app);
    const quoteA = await say(app, a, 'how much is THOCK-TK87-RED?');
    expect(quoteA.message).toMatch(/^Sure! /);
    const counterA = await say(app, a, 'can you do 4000?');
    expect(counterA.negotiation?.decision).toBe('countered');
    expect(await kinds(app, a)).toEqual(['compose', 'judge', 'compose', 'judge']);

    const before = llm.usage();
    const b = await start(app);
    const quoteB = await say(app, b, 'How much is THOCK-TK87-RED');
    await say(app, b, 'can you do 4500?');
    // A later round: the same wording as customer A's counter, but a lower price A was never offered.
    const roundTwo = await say(app, b, 'can you do 4600?');
    const after = llm.usage();

    // No phrasing call for customer B: every reply came from the cache, and every one was judged.
    expect(await kinds(app, b)).toEqual(['cache', 'judge', 'cache', 'judge', 'cache', 'judge']);
    expect(after.calls - before.calls).toBe(3);
    expect(after.judgeCalls - before.judgeCalls).toBe(3);
    expect(quoteB.message).toMatch(/^Sure! /);
    const unitA = counterA.negotiation!.quote!.unitPricePaise;
    const unitB = roundTwo.negotiation!.quote!.unitPricePaise;
    expect(roundTwo.negotiation?.decision).toBe('countered');
    expect(unitB).toBeLessThan(unitA);
    expect(roundTwo.message).toMatch(/^Sure! /);
    expect(roundTwo.message).toContain(formatInr(unitB));
    expect(roundTwo.message).not.toContain(formatInr(unitA));
  });

  it('skips the observer on a calm turn and observes injection, personal-data probes, abuse and lowball offers', async () => {
    const calm = await start(app);
    await say(app, calm, 'show me mechanical keyboards');
    expect(await observed(app, calm)).toEqual([]);
    expect(await kinds(app, calm)).not.toContain('judge');

    const injection = await start(app);
    expect((await say(app, injection, INJECTION_CORPUS[0]!)).checkoutUrl).toBeNull();
    expect((await observed(app, injection))[0]!.reasons).toEqual(expect.arrayContaining(['denied', 'high_risk']));

    const pii = await start(app);
    await say(app, pii, PII_CORPUS[0]!);
    expect((await observed(app, pii))[0]!.reasons).toContain('probe:personal_data');

    const abuse = await start(app);
    expect((await say(app, abuse, 'This is a scam, you idiots.')).handoff).toBe(true);
    expect((await observed(app, abuse))[0]!.reasons).toContain('handoff');

    // Floor probing by offers: every offer is a commitment, so each one is observed and judged.
    const lowball = await start(app);
    await say(app, lowball, 'how much is THOCK-TK87-RED?');
    await say(app, lowball, 'can you do 100?');
    await say(app, lowball, 'can you do 200?');
    const checks = await observed(app, lowball);
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.reasons.includes('commitment'))).toBe(true);
  });
});
