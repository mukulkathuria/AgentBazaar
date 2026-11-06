import { AgentCard, type Part } from '@a2a-js/sdk';
import { loadConfig } from '@agentbazaar/config';
import { A2ACheckout, A2AQuote, type NegotiationOutcome } from '@agentbazaar/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../shared/kernel/errors.js';
import { agentCard, dataPart, errorParts, readInbound, textPart } from './a2a-messages.js';
import { toA2ACheckout, toA2AQuote } from './views.js';

const NID = '0b9a6c1e-3d2f-4a5b-8c7d-9e0f1a2b3c4d';
const QID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const file: Part = { content: { $case: 'url', value: 'https://x.test/a.png' }, metadata: undefined, filename: 'a.png', mediaType: 'image/png' };

const outcome = (over: Partial<NegotiationOutcome> = {}): NegotiationOutcome => ({
  negotiationId: NID,
  state: 'counter',
  decision: 'countered',
  quote: {
    quoteId: QID,
    token: 'signed.quote-token-value',
    negotiationId: NID,
    sku: 'THOCK-TK87-RED',
    productName: 'Thock TK-87',
    quantity: 2,
    unitPricePaise: 529_900,
    listUnitPricePaise: 549_900,
    totalPaise: 1_059_800,
    currency: 'INR',
    expiresAt: '2026-11-05T10:15:00.000Z',
    status: 'active',
    terms: [],
  },
  alternatives: [{ quantity: 3, unitPricePaise: 519_900, reason: 'volume' }],
  round: 1,
  roundsRemaining: 3,
  message: 'I can do: ₹5,299 each.',
  reasonCodes: ['counter'],
  ...over,
});

describe('A2A inbound messages', () => {
  it('reads structured requests and free text, ignoring files', () => {
    const parts = [
      dataPart({ type: 'quote_request', sku: 'THOCK-TK87-RED', quantity: 2 }),
      dataPart({ type: 'offer', negotiation_id: NID, unit_price: { amount: '5000.00', currency: 'INR' } }),
      dataPart({ type: 'accept', quote_token: 'signed.quote-token-value' }),
      textPart('hello'),
      file,
      textPart('there'),
    ];
    const r = readInbound(parts);
    expect(r.data.map((d) => d.type)).toEqual(['quote_request', 'offer', 'accept']);
    expect(r.text).toBe('hello\nthere');
    expect(r.invalid).toEqual([]);
  });

  it.each([
    ['an unknown type', { type: 'refund_everything' }],
    ['a negative price', { type: 'offer', negotiation_id: NID, unit_price: { amount: '-1', currency: 'INR' } }],
    ['a NaN price', { type: 'offer', negotiation_id: NID, unit_price: { amount: 'NaN', currency: 'INR' } }],
    ['a foreign currency', { type: 'offer', negotiation_id: NID, unit_price: { amount: '10.00', currency: 'USD' } }],
    ['a fractional quantity', { type: 'quote_request', sku: 'THOCK-TK87-RED', quantity: 1.5 }],
  ])('rejects %s', (_why, data) => {
    const r = readInbound([dataPart(data)]);
    expect(r.data).toEqual([]);
    expect(r.invalid).toHaveLength(1);
  });
});

describe('A2A outbound messages', () => {
  it('maps a negotiation outcome to the A2AQuote contract with decimal-string money', () => {
    const q = A2AQuote.parse(toA2AQuote(outcome()));
    expect(q).toMatchObject({
      type: 'quote',
      negotiation_id: NID,
      sku: 'THOCK-TK87-RED',
      quantity: 2,
      unit_price: { amount: '5299.00', currency: 'INR' },
      total: { amount: '10598.00', currency: 'INR' },
      quote_token: 'signed.quote-token-value',
      rounds_remaining: 3,
      alternatives: [{ quantity: 3, unit_price: { amount: '5199.00', currency: 'INR' } }],
    });
  });

  it('describes an outcome waiting for approval with the buyer offer and no token', () => {
    const q = A2AQuote.parse(toA2AQuote(outcome({ quote: null, decision: 'pending_approval', state: 'pending_approval' }), { quantity: 3, unitPaise: 450_000 }));
    expect(q).toMatchObject({ quote_token: null, valid_until: null, quantity: 3, unit_price: { amount: '4500.00' }, total: { amount: '13500.00' } });
  });

  it('maps a checkout link to the A2ACheckout contract', () => {
    const link = { sessionId: QID, url: 'http://web.test/checkout/x?t=y', expiresAt: '2026-11-05T10:30:00.000Z', amountPaise: 1_059_800, currency: 'INR' as const };
    expect(A2ACheckout.parse(toA2ACheckout(link))).toEqual({
      type: 'checkout',
      checkout_session_id: QID,
      checkout_url: link.url,
      valid_until: link.expiresAt,
      amount: { amount: '10598.00', currency: 'INR' },
    });
  });

  it('only exposes safe error messages', () => {
    const data = (parts: Part[]) => (parts[0]!.content as { value: unknown }).value;
    expect(data(errorParts(new AppError('quote_used', 'This quote has already been used')))).toEqual({
      type: 'error',
      code: 'quote_used',
      message: 'This quote has already been used',
    });
    expect(data(errorParts(new Error('connection to 10.0.0.5:5432 refused')))).toEqual({ type: 'error', code: 'internal', message: 'Something went wrong. Please try again.' });
    expect(data(errorParts(new AppError('unavailable', 'db pool exhausted')))).toMatchObject({ code: 'unavailable', message: expect.not.stringContaining('pool') });
  });
});

describe('agent card', () => {
  const config = (env: Record<string, string>) => loadConfig({ DATABASE_DRIVER: 'pglite', PUBLIC_API_URL: 'https://api.example.in', ...env });

  it('declares v1.0 and v0.3 JSON-RPC interfaces, streaming, bearer auth and the three skills', () => {
    const json = AgentCard.toJSON(agentCard(config({}))) as Record<string, unknown>;
    expect(json).toMatchObject({
      supportedInterfaces: [
        { url: 'https://api.example.in/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: 'https://api.example.in/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
      ],
      capabilities: { streaming: true },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    });
    expect((json.skills as { id: string }[]).map((s) => s.id)).toEqual(['catalog_search', 'negotiate', 'checkout_handoff']);
    expect(json.securityRequirements).toHaveLength(1);
  });

  it('makes the token optional in demo mode', () => {
    expect(agentCard(config({ DEMO_MODE: 'true' })).securityRequirements).toEqual([]);
  });
});
