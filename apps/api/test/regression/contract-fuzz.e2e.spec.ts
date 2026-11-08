import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomizationService } from '../../src/modules/customization/index.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { adminToken, call, createShopApp, ok, type ShopApp } from '../support/shop.js';

// Regressions found by Schemathesis against the demo API (docs/testing/e2e-and-dast.md): a NUL character reached
// Postgres (text and jsonb cannot hold U+0000) and failed as a 500; the router answered contract-valid path
// parameters over 100 characters with an undocumented 414 in Fastify's own error shape; two POST routes answered
// Nest's default 201 where the contract says 200.
describe('@lite regression: API fuzzing findings', () => {
  let app: ShopApp;
  beforeAll(async () => {
    app = await createShopApp();
  });
  afterAll(async () => app.close());

  const expectEnvelope = (res: { statusCode: number; json: () => unknown }, status: number, code: string) => {
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code, message: expect.any(String), requestId: expect.any(String) } });
  };

  it('rejects a NUL character in a query, a path parameter or a JSON body with a 400, not a 500', async () => {
    expectEnvelope(await app.inject({ method: 'GET', url: '/api/v1/products?q=ab%00c' }), 400, 'validation_failed');
    expectEnvelope(await app.inject({ method: 'GET', url: '/api/v1/products/ab%00c' }), 400, 'validation_failed');
    expectEnvelope(await app.inject({ method: 'GET', url: '/api/v1/availability/ab%00c' }), 400, 'validation_failed');
    const event = await app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      payload: { kind: 'page_view', path: '/c/electronics', agent: 'bot\u0000x' },
    });
    expectEnvelope(event, 400, 'validation_failed');
  });

  it('routes a contract-valid 160-character slug to the handler (404), not to a router 414', async () => {
    expectEnvelope(await app.inject({ method: 'GET', url: `/api/v1/products/${'a'.repeat(160)}` }), 404, 'not_found');
  });

  it('answers router rejections in the contract error envelope', async () => {
    expectEnvelope(await app.inject({ method: 'GET', url: `/api/v1/products/${'a'.repeat(300)}` }), 414, 'validation_failed');
    expectEnvelope(await app.inject({ method: 'GET', url: '/api/v1/products/%E0%A4%A' }), 400, 'validation_failed');
  });

  it('answers customization validation and review decisions with the documented 200', async () => {
    const validated = await call(app, 'POST', '/api/v1/customization/MITTI-MUG-WHITE/validate', { body: { text: { name: 'Asha' } } });
    expect(ok<{ verdict: string }>(validated, 200).verdict).toBe('approved');

    await inTransaction(app.infra.db, (tx) =>
      app.app.get(CustomizationService).flagForReview(tx, 'MITTI-MUG-WHITE', [{ field: 'name', text: 'review me', flags: ['wordlist'] }]),
    );
    const token = await adminToken(app);
    const [review] = ok<{ id: string }[]>(await call(app, 'GET', '/api/v1/admin/reviews', { token }), 200);
    ok(await call(app, 'POST', `/api/v1/admin/reviews/${review!.id}/decide`, { body: { approve: true }, token }), 200);
  });
});
