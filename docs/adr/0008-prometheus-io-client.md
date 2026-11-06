# ADR 0008: Use `@prometheus-io/client` for metrics

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

The API exposes Prometheus metrics at `/metrics` (never exposed publicly; Caddy answers 404 for it). The long-standing Node.js client was published as `prom-client`. Its maintainers now publish it as `@prometheus-io/client` from the Prometheus organisation's `prometheus/client_js` repository, under Apache-2.0; the package README says it "was previously published as `prom-client`", and the old name is deprecated. A new project should not start on a deprecated package name.

## Decision

- Use `@prometheus-io/client` with one `Registry` per app instance (so parallel test apps do not collide on metric names), default process metrics with the `agentbazaar_` prefix, and these application metrics:
  - `agentbazaar_http_request_duration_seconds` (method, route pattern, status), labelled by route pattern rather than raw URL so checkout and order tokens in query strings never reach the metrics;
  - `agentbazaar_negotiation_decisions_total` (band, decision, channel);
  - `agentbazaar_llm_tokens_total` (tier, direction) and `agentbazaar_router_tier_total` (tier, intent);
  - `agentbazaar_outbox_pending`;
  - `agentbazaar_orders_created_total` (payment method).
- OpenTelemetry tracing is added in growth through `OTEL_EXPORTER_OTLP_ENDPOINT`; Prometheus remains the metrics format.

## Consequences

- The API is the familiar `Registry`, `Counter`, `Gauge`, `Histogram` and `collectDefaultMetrics` interface, so existing knowledge and dashboards carry over.
- Breaking changes listed in the package's changelog apply when moving from old `prom-client` versions; we start on the new name, so there is nothing to migrate.
- Renovate tracks the new package name.

## Alternatives considered

- **`prom-client`:** deprecated name; no future updates there.
- **OpenTelemetry metrics SDK only:** a heavier dependency for lite, where a Prometheus scrape is all that is needed.
