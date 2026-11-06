# ADR 0015: Growth platform on Kubernetes: APISIX in standalone mode, an agent pool, conftest policies, opt-in tracing

- Status: Accepted
- Date: 2026-11-06
- Deciders: Mukul Kathuria

## Context

Milestone G4 puts the growth profile on k3s with Helm, OpenBao, an APISIX gateway, OPA policies, Prometheus and
OpenTelemetry, and is done when a fresh cluster install passes smoke and end-to-end suites. S6 adds an autoscaled
pool for agent traffic. The chart already ran api, web and ai with non-root, read-only containers, default-deny
NetworkPolicies and a migration hook. Each new piece needed a decision that keeps lite unchanged and the chart
installable with no operators or CRDs.

## Decision

- **APISIX runs inside the chart in standalone (YAML) mode.** `gateway.enabled` renders a Deployment of
  `apache/apisix:3.19.0-debian` whose `config.yaml` and `apisix.yaml` come from a ConfigMap built from values. There
  is no etcd and no ingress controller, and no CRDs. Routes are by host: the storefront host goes to web, while the API host
  sends `/mcp`, `/a2a` and `/api/v1/chat` to the agent pool and everything else to api. `limit-count` keys on the
  bearer token, falling back to the client IP (real IPs come from `X-Forwarded-For` of trusted proxies).
  `client-control` caps bodies at the API's own 256 KiB. Access logs carry paths only: query strings can hold
  order and checkout tokens. The Ingress, or the AWS target groups, point at the gateway when it is on. APISIX
  renders `nginx.conf` into its install directory at start, so `conf/` (seeded from the image by an init
  container) and the nginx runtime paths are emptyDirs. The container keeps a read-only root filesystem and
  runs as uid 636 with no capabilities.
- **The agent pool is the api image again**, as a separate Deployment, Service, PDB and HPA (`agents.enabled`, on
  in scale). It scales on CPU, and `autoscaling.extraMetrics` adds a request-rate metric when prometheus-adapter
  serves one. Agent calls wait on LLMs more than they burn CPU, so that is the better signal where it is
  available. MCP is stateless here, so no session affinity is needed.
- **Policies are Rego run by conftest**, in `deploy/policies/kubernetes` and `deploy/policies/terraform`, each with
  `conftest verify` unit tests. The chart's rendered manifests are checked for all three values files with
  `--combine`, so one rule can require a NetworkPolicy over every workload. The Terraform rules read real plan
  JSON without cloud credentials: the plan comes from the `test_plan` messages that `tofu test -json -verbose`
  prints for the `plans_with_defaults` run, which plans against the mocked AWS provider the tests already use.
- **Tracing is opt-in and loaded lazily.** `main.ts` imports the OpenTelemetry Node SDK only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set, before it imports the app, so lite pays nothing. The SDK sends traces only,
  over OTLP/HTTP protobuf; metrics stay on Prometheus. It instruments http, Fastify (`@fastify/otel` via the
  `fastify.initialization` diagnostics channel), pg and undici. A span processor runs as each span ends: it drops
  query values and caller IPs and passes every string through the log redaction rules. SQL parameters, bodies and
  headers are never recorded. Pino lines inside a span carry `trace_id` and `span_id`.
- **Lite to growth for PII keys is a command**, `cli pii rewrap`. It moves each customer's data key from the env
  master key to OpenBao Transit (reading the result back before replacing anything), and it re-wraps Transit
  ciphertext after a key rotation. It works in batches of one transaction each, with a token cursor, so it is
  idempotent and resumable, and it never touches field ciphertext.

## Consequences

- One `helm install` brings up the whole growth edge: no APISIX ingress controller, etcd or Prometheus Operator is
  required, and k3s's bundled Traefik (or an ALB) stays the TLS front door.
- Gateway rate limits are per gateway replica (`policy: local`). The app's per-agent quota (the token's `qpm`
  claim, counted in Valkey) remains the authoritative limit. A shared Valkey policy can follow if the limits need
  to be global.
- Route changes need a Helm upgrade (the pods roll on a config checksum), not an admin API call.
- Policy failures block IaC CI. Exceptions are changes to the Rego with a test, reviewed like code.
- A Temporal worker whose native core needs glibc runs from its own image target, and its egress is limited to
  the ports of the services it uses.

## Alternatives considered

- **APISIX Helm chart with etcd and the APISIX ingress controller:** more moving parts, CRDs and a stateful etcd for
  what is a fixed route table owned by this chart.
- **Gateway rules in the Ingress controller (Traefik middlewares, nginx annotations):** ties limits to one
  controller and gives no per-token limits.
- **Gatekeeper or Kyverno admission policies:** enforce only in a running cluster; conftest checks every PR without
  one. The same Rego could later feed Gatekeeper.
- **OpenTelemetry auto-instrumentations bundle:** pulls dozens of instrumentations and needs ESM loader hooks; the
  four we use work through `require` hooks and diagnostics channels on Node 24.
- **Writable root filesystem for APISIX:** simpler, but it is the one exception the policies would need.
