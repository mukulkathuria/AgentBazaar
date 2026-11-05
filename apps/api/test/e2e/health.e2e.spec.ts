import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/test-app.js';

describe('@lite app boot, health and error envelope', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => app.close());

  it('reports liveness and readiness with outbox lag', async () => {
    const live = await app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', outbox: { pending: 0 } });
  });

  it('exposes Prometheus metrics', async () => {
    await app.inject({ method: 'GET', url: '/healthz' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('agentbazaar_http_request_duration_seconds');
  });

  it('returns the contract error envelope for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/no/such/route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('sets security headers and echoes a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'req-abcdef123' } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-request-id']).toBe('req-abcdef123');
  });

  it('replaces a malicious request id instead of logging it', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'bad id injected' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects malformed and forged bearer tokens', async () => {
    const malformed = await app.inject({ method: 'GET', url: '/healthz', headers: { authorization: 'Basic abc' } });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const forged = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' },
    });
    expect(forged.statusCode).toBe(401);
  });
});
