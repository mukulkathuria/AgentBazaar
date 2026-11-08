import { DashboardView } from '@agentbazaar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, buy, call, createShopApp, ok, pay, registerCustomer, type ShopApp } from '../support/shop.js';

// Regression (found by the Playwright admin journey): the contract and the admin console had the dashboard,
// the API never served it, so every admin landed on "The store is temporarily unavailable".
describe('@lite admin dashboard', () => {
  let app: ShopApp;
  beforeAll(async () => {
    app = await createShopApp();
  });
  afterAll(async () => app.close());

  const dashboard = async () =>
    DashboardView.parse(ok(await call(app, 'GET', '/api/v1/admin/dashboard', { token: await adminToken(app) }), 200));

  it('is for admins only', async () => {
    expect((await call(app, 'GET', '/api/v1/admin/dashboard')).statusCode).toBe(401);
    const customer = await registerCustomer(app);
    expect((await call(app, 'GET', '/api/v1/admin/dashboard', { token: customer.accessToken })).statusCode).toBe(403);
  });

  it('adds up orders, negotiations, conversations, AI crawler hits and queues', async () => {
    const before = await dashboard();

    const { order: paid } = await buy(app, { sku: 'THOCK-TK87-RED', quantity: 1 });
    await pay(app, paid);
    await buy(app, { sku: 'KOKOA-MINI-13G', quantity: 1 }); // never paid
    const { sessionId } = ok<{ sessionId: string }>(await call(app, 'POST', '/api/v1/chat/sessions', { body: { language: 'en' } }), 201);
    for (const text of ['how much is THOCK-TK87-RED?', 'can you do 4000', 'ok deal']) {
      ok(await call(app, 'POST', `/api/v1/chat/sessions/${sessionId}/messages`, { body: { text } }), 200);
    }
    const hit = { kind: 'crawler_hit', path: '/p/thock-tk87-mechanical-keyboard', agent: 'GPTBot' };
    ok(await call(app, 'POST', '/api/v1/analytics/events', { body: hit }), 202);
    await app.drain();

    const d = await dashboard();
    expect(d.orders).toEqual({
      total: before.orders.total + 2,
      paid: before.orders.paid + 1,
      revenuePaise: before.orders.revenuePaise + paid.totalPaise,
    });
    expect(d.negotiations).toMatchObject({ total: before.negotiations.total + 1, accepted: before.negotiations.accepted + 1 });
    expect(d.negotiations.acceptRate).toBeGreaterThan(0);
    expect(d.negotiations.avgDiscountBps).toBeGreaterThan(0); // the deal closed below list price
    expect(d.agents.conversations).toBe(before.agents.conversations + 1);
    const turns = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
    expect(turns(d.agents.tierCounts)).toBe(turns(before.agents.tierCounts) + 3);
    expect(d.geo.crawlerHits.GPTBot).toBe((before.geo.crawlerHits.GPTBot ?? 0) + 1);
    expect(d.queues).toEqual({ approvals: expect.any(Number), reviews: expect.any(Number), handoffs: expect.any(Number) });
  });
});
