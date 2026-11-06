import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bandForPrice } from './catalog.js';
import { McpToolInputs, A2AInbound } from './agent.js';
import { AddressInput, StartCheckoutInput } from './orders.js';
import { buildOpenApi, toFastifyPath } from './openapi.js';
import { Routes } from './routes.js';

describe('@lite contracts', () => {
  it('assigns price bands at the documented thresholds', () => {
    expect(bandForPrice(2000)).toBe('fixed');
    expect(bandForPrice(49_999)).toBe('fixed');
    expect(bandForPrice(50_000)).toBe('standard');
    expect(bandForPrice(2_000_000)).toBe('standard');
    expect(bandForPrice(2_000_001)).toBe('premium');
  });

  it('every MCP tool input converts to a JSON Schema object', () => {
    for (const [name, schema] of Object.entries(McpToolInputs)) {
      const json = z.toJSONSchema(schema, { io: 'input' }) as { type?: string };
      expect(json.type, name).toBe('object');
    }
  });

  it('A2A inbound messages are discriminated by type', () => {
    const offer = A2AInbound.parse({
      type: 'offer',
      negotiation_id: '0d3c6c43-2a5e-4b5e-9a39-6a8f7e2b1c11',
      unit_price: { amount: '2399.00', currency: 'INR' },
    });
    expect(offer.type).toBe('offer');
    expect(A2AInbound.safeParse({ type: 'pay_now', amount: 1 }).success).toBe(false);
  });

  it('rejects mass assignment on strict inputs', () => {
    const r = AddressInput.safeParse({
      name: 'Asha',
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      stateCode: 'KA',
      pincode: '560001',
      isAdmin: true,
    });
    expect(r.success).toBe(false);
  });

  it('checkout starts from exactly one of cart or quote', () => {
    expect(StartCheckoutInput.safeParse({ cartId: '0d3c6c43-2a5e-4b5e-9a39-6a8f7e2b1c11' }).success).toBe(true);
    expect(StartCheckoutInput.safeParse({}).success).toBe(false);
  });

  it('builds a valid, deterministic OpenAPI document covering every route', () => {
    const doc = buildOpenApi('0.9.0') as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe('3.1.0');
    const ops = Object.values(doc.paths).flatMap((p) => Object.keys(p));
    expect(ops).toHaveLength(Object.keys(Routes).length);
    expect(JSON.stringify(buildOpenApi('0.9.0'))).toBe(JSON.stringify(doc));
  });

  it('documents the transport limits the server can answer with (found by Schemathesis)', () => {
    const doc = buildOpenApi('0.9.0') as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    const codes = (path: string, method: string) => Object.keys(doc.paths[path]![method]!.responses);
    expect(codes('/api/v1/products/{slug}', 'get')).toEqual(expect.arrayContaining(['414', '431']));
    expect(codes('/api/v1/products/{slug}', 'get')).not.toContain('413'); // GET bodies are never read
    expect(codes('/api/v1/products', 'get')).not.toContain('414'); // no path parameter
    expect(codes('/api/v1/analytics/events', 'post')).toEqual(expect.arrayContaining(['413', '431']));
  });

  it('route paths are unique per method and convert to Fastify syntax', () => {
    const keys = Object.values(Routes).map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(toFastifyPath('/api/v1/carts/{id}/lines/{lineId}')).toBe('/api/v1/carts/:id/lines/:lineId');
  });
});
