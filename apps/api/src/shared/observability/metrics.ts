import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/** One registry per app instance, so parallel test apps do not collide on metric names. */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'agentbazaar_' });
  return {
    registry,
    httpDuration: new Histogram({
      name: 'agentbazaar_http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.3, 0.5, 0.8, 1.5, 3],
      registers: [registry],
    }),
    negotiationDecisions: new Counter({
      name: 'agentbazaar_negotiation_decisions_total',
      help: 'Seller decisions by band and outcome',
      labelNames: ['band', 'decision', 'channel'] as const,
      registers: [registry],
    }),
    llmTokens: new Counter({
      name: 'agentbazaar_llm_tokens_total',
      help: 'LLM tokens by tier and direction',
      labelNames: ['tier', 'direction'] as const,
      registers: [registry],
    }),
    semanticCache: new Counter({
      name: 'agentbazaar_semantic_cache_total',
      help: 'Semantic cache lookups (hit, miss, rejected by the guard) and writes (stored, skipped as unsafe to share)',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    observerTurns: new Counter({
      name: 'agentbazaar_observer_turns_total',
      help: 'Chat turns the observer reviewed or skipped, and replies it replaced',
      labelNames: ['decision'] as const,
      registers: [registry],
    }),
    routerTier: new Counter({
      name: 'agentbazaar_router_tier_total',
      help: 'Router decisions per tier',
      labelNames: ['tier', 'intent'] as const,
      registers: [registry],
    }),
    outboxPending: new Gauge({
      name: 'agentbazaar_outbox_pending',
      help: 'Unpublished outbox events',
      registers: [registry],
    }),
    ordersCreated: new Counter({
      name: 'agentbazaar_orders_created_total',
      help: 'Orders created by payment method',
      labelNames: ['method'] as const,
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
