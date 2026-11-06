import { randomBytes } from 'node:crypto';
import { redact } from '../../../shared/observability/redact.js';
import type { LlmTrace } from '../../audit/index.js';
import type { LlmTracer } from '../application/phraser.js';
import { INR_PER_USD } from '../domain/budget.js';

export interface LangfuseOptions {
  host: string;
  publicKey: string;
  secretKey: string;
  /** Spans per request; a full batch is sent at once. */
  batchSize?: number;
  /** How long a partial batch waits before it is sent. */
  flushMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (err: unknown) => void;
  now?: () => number;
}

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

const MAX_BUFFERED = 1000;
const TIMEOUT_MS = 5000;
const SPAN_KIND_CLIENT = 3;

function value(v: string | number | boolean): AttrValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

const attributes = (o: Record<string, string | number | boolean | null>) =>
  Object.entries(o).flatMap(([key, v]) => (v === null ? [] : [{ key, value: value(v) }]));

const nanos = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();

/**
 * Langfuse exporter over its OpenTelemetry endpoint (OTLP/HTTP with JSON at /api/public/otel/v1/traces),
 * plain fetch and no SDK. One generation span per model call carries the route, model, tokens, cost and
 * latency. Prompts and replies are PII-redacted with the audit-trace rules before they leave the process.
 * Spans are batched; a failed export is reported and dropped, never retried on a reply's path.
 */
export class LangfuseTracer implements LlmTracer {
  private readonly url: string;
  private readonly auth: string;
  private buffer: object[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: LangfuseOptions) {
    this.url = `${opts.host.replace(/\/+$/, '')}/api/public/otel/v1/traces`;
    this.auth = `Basic ${Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString('base64')}`;
  }

  record(t: LlmTrace): void {
    // shortcut: drops spans while Langfuse is slower than traffic; add a disk spool if every span must arrive.
    if (this.buffer.length >= MAX_BUFFERED) return;
    this.buffer.push(this.span(t));
    if (this.buffer.length >= (this.opts.batchSize ?? 50)) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.opts.flushMs ?? 2000).unref();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const spans = this.buffer.splice(0);
    if (!spans.length) return;
    const body = {
      resourceSpans: [
        {
          resource: { attributes: attributes({ 'service.name': 'agentbazaar-api' }) },
          scopeSpans: [{ scope: { name: 'agentbazaar.agent' }, spans }],
        },
      ],
    };
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.url, {
        method: 'POST',
        headers: { authorization: this.auth, 'content-type': 'application/json', 'x-langfuse-ingestion-version': '4' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Langfuse answered HTTP ${res.status}`);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private span(t: LlmTrace): object {
    const end = (this.opts.now ?? Date.now)();
    return {
      traceId: randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
      name: `chat.${t.kind ?? 'compose'}`,
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: nanos(end - t.latencyMs),
      endTimeUnixNano: nanos(end),
      attributes: attributes({
        'langfuse.trace.name': `chat.${t.kind ?? 'compose'}`,
        'langfuse.session.id': t.sessionId,
        'langfuse.observation.type': 'generation',
        'langfuse.observation.model.name': t.model,
        'langfuse.observation.input': redact(t.input),
        'langfuse.observation.output': redact(t.output),
        'langfuse.observation.usage_details': JSON.stringify({ input: t.tokensIn, output: t.tokensOut }),
        'langfuse.observation.cost_details': JSON.stringify({ total: t.costMicroInr / 1e6 / INR_PER_USD }),
        'langfuse.observation.metadata.tier': t.tier,
        'langfuse.observation.metadata.shadow_tier': t.shadowTier,
        'langfuse.observation.metadata.intent': t.intent,
        'langfuse.observation.metadata.channel': t.channel,
        'langfuse.observation.metadata.cost_micro_inr': t.costMicroInr,
        'langfuse.observation.metadata.latency_ms': t.latencyMs,
        'langfuse.observation.metadata.guard_fallback': t.guardFallback,
      }),
      status: { code: 1 },
    };
  }
}
