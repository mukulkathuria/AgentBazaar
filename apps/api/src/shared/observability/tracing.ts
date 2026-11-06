import { readFileSync } from 'node:fs';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { type Attributes, SpanKind } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type Span, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { redact } from './redact.js';

/** Probe and scrape endpoints: high volume, no diagnostic value. */
const UNTRACED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);
/** URL attributes whose query string can carry checkout and order tokens (`?t=`). */
const URL_KEY = /^(url\.|http\.(url|target)$)/;
/** The caller's IP on server spans (socket peer or X-Forwarded-For); client spans keep their peer (Postgres, OpenBao). */
const CLIENT_KEYS = ['client.address', 'network.peer.address', 'http.client_ip', 'net.peer.ip'];

/** Keeps query parameter names and drops every value: `t=abc&q=x` -> `t=REDACTED&q=REDACTED`. */
function scrubQuery(query: string): string {
  return query
    .split('&')
    .map((part) => (part.includes('=') ? `${part.slice(0, part.indexOf('='))}=REDACTED` : 'REDACTED'))
    .join('&');
}

function scrubValue(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map((v) => (typeof v === 'string' ? redact(v) : v));
  if (typeof value !== 'string') return value;
  if (key === 'url.query') return scrubQuery(value);
  const q = URL_KEY.test(key) ? value.indexOf('?') : -1;
  return q < 0 ? redact(value) : `${redact(value.slice(0, q))}?${scrubQuery(value.slice(q + 1))}`;
}

function scrubAttributes(attributes: Attributes): void {
  for (const key of Object.keys(attributes)) attributes[key] = scrubValue(key, attributes[key]);
}

/**
 * Runs as each span ends, before export: drops query values and the caller's IP, and passes every
 * string through the log redaction rules (email, phone, card, Aadhaar, PAN, UPI). Bodies, headers
 * and SQL parameters are never captured in the first place (see `instrumentations`).
 */
export class RedactingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    span.updateName(redact(span.name));
    scrubAttributes(span.attributes);
    if (span.kind === SpanKind.SERVER) for (const key of CLIENT_KEYS) delete span.attributes[key];
    for (const event of span.events) if (event.attributes) scrubAttributes(event.attributes);
    if (span.status.message) span.setStatus({ ...span.status, message: redact(span.status.message) });
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function instrumentations() {
  return [
    // No headers are captured (headersToSpanAttributes stays unset); probes are not traced.
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => UNTRACED_PATHS.has((req.url ?? '').split('?')[0]!),
      // Background jobs (outbox relay, scheduler) would otherwise start a trace per poll.
      requireParentforOutgoingSpans: true,
    }),
    // Fastify announces each new instance on a diagnostics channel, so no module patching is needed.
    new FastifyOtelInstrumentation({ registerOnInitialization: true, ignorePaths: ({ url }) => UNTRACED_PATHS.has(url) }),
    // SQL text only: parameter values stay out of spans and queries are not rewritten with comments.
    new PgInstrumentation({ enhancedDatabaseReporting: false, addSqlCommenterCommentToQueries: false, requireParentSpan: true }),
    new UndiciInstrumentation({ requireParentforSpans: true }),
  ];
}

function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

/**
 * Starts OpenTelemetry tracing (traces only: metrics stay on Prometheus /metrics). main.ts calls this
 * only when OTEL_EXPORTER_OTLP_ENDPOINT is set, before it imports the app, so instrumented modules are
 * patched as they load. The exporter reads the standard OTEL_EXPORTER_OTLP_* variables, and
 * OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES override the defaults below.
 */
export function startTracing(exporter: SpanExporter = new OTLPTraceExporter()): NodeSDK {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'agentbazaar-api',
    resource: defaultResource().merge(resourceFromAttributes({ 'service.version': packageVersion() })),
    spanProcessors: [new RedactingSpanProcessor(), new BatchSpanProcessor({ exporter })],
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: instrumentations(),
  });
  sdk.start();
  return sdk;
}
