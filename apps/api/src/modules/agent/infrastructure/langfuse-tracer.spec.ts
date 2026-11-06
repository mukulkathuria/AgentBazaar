import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '@agentbazaar/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../shared/observability/logger.js';
import type { LlmTrace } from '../../audit/index.js';
import { createTracer } from './factories.js';
import { LangfuseTracer } from './langfuse-tracer.js';

interface Span {
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
}
interface Received {
  url: string;
  headers: IncomingHttpHeaders;
  spans: Span[];
  raw: string;
}

const KEYS = { publicKey: 'public-test', secretKey: 'secret-test' };
const trace: LlmTrace = {
  sessionId: '6f1c2a5e-8f0b-4c55-9a51-2b7d8f3c1e90',
  channel: 'chat',
  tier: 3,
  shadowTier: 2,
  kind: 'compose',
  model: 'claude-sonnet-5-5',
  intent: 'make_offer',
  input: '{"buyer_message":"mail me at asha.verma@example.com or call 9876543210"}',
  output: 'Sure! I can offer ₹5,199 each. Call 9876543210 anytime.',
  tokensIn: 812,
  tokensOut: 41,
  costMicroInr: 179_000,
  latencyMs: 420,
  guardFallback: false,
  sampledForAudit: false,
};
const attrs = (s: Span) => Object.fromEntries(s.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

describe('Langfuse tracing', () => {
  let server: Server;
  let host: string;
  const received: Received[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        const body = JSON.parse(raw) as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };
        received.push({ url: req.url ?? '', headers: req.headers, spans: body.resourceSpans[0]!.scopeSpans[0]!.spans, raw });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    received.length = 0;
  });

  it('exports one redacted generation span per model call with route, model, tokens, cost and latency', async () => {
    const tracer = new LangfuseTracer({ host: `${host}/`, ...KEYS, now: () => 1_762_400_000_000 });
    tracer.record(trace);
    tracer.record({ ...trace, kind: 'judge', output: 'PASS', tokensIn: 300, tokensOut: 1 });
    await tracer.flush();

    expect(received).toHaveLength(1);
    const [r] = received;
    expect(r!.url).toBe('/api/public/otel/v1/traces');
    expect(r!.headers.authorization).toBe(`Basic ${Buffer.from('public-test:secret-test').toString('base64')}`);
    expect(r!.spans.map((s) => s.name)).toEqual(['chat.compose', 'chat.judge']);
    const a = attrs(r!.spans[0]!);
    expect(a).toMatchObject({
      'langfuse.observation.type': 'generation',
      'langfuse.observation.model.name': 'claude-sonnet-5-5',
      'langfuse.session.id': trace.sessionId,
      'langfuse.observation.metadata.tier': '3',
      'langfuse.observation.metadata.shadow_tier': '2',
      'langfuse.observation.metadata.intent': 'make_offer',
      'langfuse.observation.metadata.cost_micro_inr': '179000',
      'langfuse.observation.metadata.latency_ms': '420',
    });
    expect(JSON.parse(String(a['langfuse.observation.usage_details']))).toEqual({ input: 812, output: 41 });
    expect((JSON.parse(String(a['langfuse.observation.cost_details'])) as { total: number }).total).toBeCloseTo(0.179 / 88, 8);
    expect(r!.spans[0]!.endTimeUnixNano).toBe('1762400000000000000');
    expect(BigInt(r!.spans[0]!.endTimeUnixNano) - BigInt(r!.spans[0]!.startTimeUnixNano)).toBe(420_000_000n);
    // The same redaction rules as the audit traces: no e-mail address or phone number leaves the process.
    expect(r!.raw).not.toContain('asha.verma@example.com');
    expect(r!.raw).not.toContain('9876543210');
    expect(r!.raw).toContain('[EMAIL]');
    expect(r!.raw).toContain('[PHONE]');
  });

  it('sends a full batch at once and a partial one after the flush interval', async () => {
    const tracer = new LangfuseTracer({ host, ...KEYS, batchSize: 2, flushMs: 20 });
    tracer.record(trace);
    tracer.record(trace);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    tracer.record(trace);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received.map((r) => r.spans.length)).toEqual([2, 1]);
  });

  it('reports a failed export without throwing into the reply path', async () => {
    const errors: unknown[] = [];
    const tracer = new LangfuseTracer({ host: 'http://127.0.0.1:9', ...KEYS, onError: (e) => errors.push(e) });
    expect(() => tracer.record(trace)).not.toThrow();
    await tracer.flush();
    expect(errors).toHaveLength(1);
  });

  it('is a no-op unless LANGFUSE_HOST and its keys are set', () => {
    const logger = createLogger('silent');
    const off = createTracer(loadConfig({ DATABASE_DRIVER: 'pglite' }), logger);
    expect(off).not.toBeInstanceOf(LangfuseTracer);
    expect(() => off.record(trace)).not.toThrow();
    const env = { DATABASE_DRIVER: 'pglite', LANGFUSE_HOST: host, LANGFUSE_PUBLIC_KEY: 'public-test', LANGFUSE_SECRET_KEY: 'secret-test' };
    expect(createTracer(loadConfig(env), logger)).toBeInstanceOf(LangfuseTracer);
  });
});
