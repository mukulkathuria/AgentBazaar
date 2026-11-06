import { once } from 'node:events';
import type * as Http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { type ProxyTracerProvider, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { RedactingSpanProcessor, startTracing } from './tracing.js';

describe('RedactingSpanProcessor', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new RedactingSpanProcessor(), new SimpleSpanProcessor({ exporter })],
  });
  const tracer = provider.getTracer('test');

  it('drops query values and caller IPs, and redacts PII in every string', () => {
    const span = tracer.startSpan('GET', {
      kind: SpanKind.SERVER,
      attributes: {
        'url.path': '/api/v1/orders/ord_1?t=secret-order-token',
        'url.query': 't=secret-order-token&q=keyboard&flag',
        'client.address': '203.0.113.7',
        'network.peer.address': '10.0.0.9',
        'user_agent.original': 'BuyerBot/1.0 (ops@example.com)',
        'http.response.status_code': 500,
        tags: ['call 9876543210', 'ok'],
      },
    });
    span.recordException(new Error('no customer asha@example.com'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'card 4111 1111 1111 1111 declined' });
    span.end();
    const [out] = exporter.getFinishedSpans();
    expect(out!.attributes).toEqual({
      'url.path': '/api/v1/orders/ord_1?t=REDACTED',
      'url.query': 't=REDACTED&q=REDACTED&REDACTED',
      'user_agent.original': 'BuyerBot/1.0 ([EMAIL])',
      'http.response.status_code': 500,
      tags: ['call [PHONE]', 'ok'],
    });
    expect(out!.events[0]!.attributes!['exception.message']).toBe('no customer [EMAIL]');
    expect(String(out!.events[0]!.attributes!['exception.stacktrace'])).not.toContain('asha@example.com');
    expect(out!.status.message).toBe('card [CARD] declined');
  });

  it('keeps the peer of client spans (the database, OpenBao) and URLs without a query', () => {
    exporter.reset();
    tracer
      .startSpan('pg.query:SELECT', {
        kind: SpanKind.CLIENT,
        attributes: { 'network.peer.address': '10.0.0.5', 'url.full': 'http://openbao:8200/v1/transit/encrypt/k', 'db.query.text': 'SELECT $1' },
      })
      .end();
    expect(exporter.getFinishedSpans()[0]!.attributes).toEqual({
      'network.peer.address': '10.0.0.5',
      'url.full': 'http://openbao:8200/v1/transit/encrypt/k',
      'db.query.text': 'SELECT $1',
    });
  });
});

describe('startTracing with the real http and undici instrumentations', () => {
  const exporter = new InMemorySpanExporter();
  let sdk: NodeSDK;
  let server: Http.Server;
  let base: string;

  beforeAll(async () => {
    sdk = startTracing(exporter);
    // In production Fastify's own require('node:http') triggers the patch; here the test loads it.
    const http = createRequire(import.meta.url)('node:http') as typeof Http;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => res.end(req.url === '/healthz' ? 'ok' : JSON.stringify({ got: body.length })));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await sdk.shutdown();
  });

  const flush = () => ((trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as TracerProvider).forceFlush();

  it('records a server span with no token, body, header or IP, and skips probes', async () => {
    const res = await fetch(`${base}/api/v1/orders/ord_1?t=secret-order-token`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-bearer', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.4' },
      body: JSON.stringify({ email: 'asha@example.com', phone: '9876543210' }),
    });
    expect(res.status).toBe(200);
    await (await fetch(`${base}/healthz`)).text();
    await flush();

    const spans = exporter.getFinishedSpans();
    const servers = spans.filter((s) => s.kind === SpanKind.SERVER);
    expect(servers).toHaveLength(1); // /healthz is not traced
    const attrs = servers[0]!.attributes;
    expect(attrs['url.path']).toBe('/api/v1/orders/ord_1');
    expect(attrs['url.query']).toBe('t=REDACTED');
    expect(attrs['client.address']).toBeUndefined();
    expect(attrs['network.peer.address']).toBeUndefined();
    expect(servers[0]!.resource.attributes['service.name']).toBe('agentbazaar-api');
    expect(servers[0]!.resource.attributes['service.version']).toMatch(/^\d+\.\d+\.\d+/);
    const everything = JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes, e: s.events })));
    for (const secret of ['secret-order-token', 'secret-bearer', 'asha@example.com', '9876543210', '198.51.100.4']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('puts the trace and span ids on log lines written inside a span', () => {
    const lines: string[] = [];
    const logger = createLogger('info', new Writable({ write: (c: Buffer, _e, cb) => (lines.push(c.toString()), cb()) }));
    logger.info('outside');
    trace.getTracer('test').startActiveSpan('work', (span) => {
      logger.info('inside');
      const [outside, inside] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(outside).not.toHaveProperty('trace_id');
      expect(inside).toMatchObject({ trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });
      span.end();
    });
  });
});
