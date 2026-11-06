# Running AgentBazaar on Kubernetes (growth and scale)

The Helm chart in [`deploy/helm/agentbazaar`](../../deploy/helm/agentbazaar) runs the growth profile on k3s or any
Kubernetes 1.29+ and the scale profile on multi-AZ EKS. This page covers installing it, the components the
profiles turn on, the gateway, the agent pool, the PII key move to OpenBao, Keycloak, tracing and the policies
every chart change has to pass. Design decisions: [ADR 0015](../adr/0015-growth-platform-on-kubernetes.md).

| Component | Values key | lite (values.yaml) | growth | scale |
| --- | --- | --- | --- | --- |
| API | `api` | 1 replica | 2–8, HPA | 3–20, HPA, zone spread |
| Storefront | `web` | 1 replica | 2–6, HPA | 3–12, HPA, zone spread |
| APISIX gateway | `gateway` | off | 2 replicas | 3, spread over zones |
| Agent pool (`/mcp`, `/a2a`, `/api/v1/chat`) | `agents` | off | off | 3–30, HPA, zone spread |
| PgBouncer (transaction pooling) | `pgbouncer` | off | 2 replicas | off |
| Temporal workflow worker | `workflowWorker` | off | off | 2, zone spread |
| AI service | `ai` | off | off | off |
| Archival CronJob | `archive` | off | off | off |

Every pod runs as non-root with a read-only root filesystem, no privilege escalation, all capabilities dropped, the
RuntimeDefault seccomp profile, requests and limits, and no service-account token. A default-deny NetworkPolicy
covers the release; narrower policies open only the paths below.

## Install

The chart never creates secrets. Create the Secret first (default name `agentbazaar-secrets`):

| Key | Needed when |
| --- | --- |
| `DATABASE_URL` | always. With PgBouncer: `postgres://USER:PASS@<release>-pgbouncer:6432/DB` |
| `PGBOUNCER_DATABASE_URL` | `pgbouncer.enabled`: the primary itself; PgBouncer and the migration Job use it |
| `DATABASE_REPLICA_URLS` | read replicas (comma-separated) |
| `QUOTE_SIGNING_KEY`, `PII_MASTER_KEY`, `PII_BLIND_INDEX_KEY`, `JWT_PRIVATE_KEY` | always in production (`cli keys` prints them) |
| `OPENBAO_TOKEN` | growth and scale (`SECRETS_ADAPTER=openbao`) |
| `MEILISEARCH_API_KEY`, `CLICKHOUSE_URL`, `LANGFUSE_SECRET_KEY`, `ANTHROPIC_API_KEY`, payment keys | when used |

Then install, layering the profile's values (and on AWS, Terraform's `helm_values`):

```bash
kubectl create namespace agentbazaar
kubectl -n agentbazaar create secret generic agentbazaar-secrets --from-env-file=app.env
helm upgrade --install agentbazaar deploy/helm/agentbazaar -n agentbazaar \
  -f deploy/helm/agentbazaar/values-growth.yaml -f my-values.yaml
```

On k3s, `my-values.yaml` sets the public URLs, `VALKEY_URL`, the Ingress (`ingress.enabled: true`,
`className: traefik`), `targetGroupBindings.enabled: false` and `networkPolicy.ingressFrom` for Traefik's namespace
(`kube-system`). [`tests/cluster/values-k3d.yaml`](../../tests/cluster/values-k3d.yaml) is a working example. Meilisearch, NATS
JetStream, Valkey, Postgres and OpenBao come from their own charts or managed services
([`tests/cluster/deps.yaml`](../../tests/cluster/deps.yaml) has throwaway versions for tests).

OpenBao needs a Transit engine and a **derived** key, because each customer's token is the key-derivation context:

```bash
bao secrets enable transit
bao write -f transit/keys/agentbazaar-pii derived=true   # OPENBAO_TRANSIT_KEY; mount: OPENBAO_TRANSIT_MOUNT
```

Migrations run in a `pre-install,pre-upgrade` Job; the app pods start with `SKIP_MIGRATIONS=true`. Seed a demo
catalog with `kubectl -n agentbazaar exec deploy/agentbazaar-api -- node dist/cli/index.js seed`.

## Configuration the profiles add

Non-secret settings live in `config` (a ConfigMap shared by every app pod); empty values are left out.

| Key | Purpose |
| --- | --- |
| `DATABASE_REPLICA_MAX_LAG_MS` | growth: `5000`. Reads fall back to the primary when a replica lags more |
| `SEMANTIC_CACHE`, `SEMANTIC_CACHE_THRESHOLD` | growth and scale: `valkey`; the threshold defaults to 0.9 |
| `WORKFLOW_ENGINE`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` | scale: `temporal`, `temporal-frontend:7233`, `default`, `agentbazaar-checkout` |
| `ANALYTICS_ADAPTER` | scale: `clickhouse` (`CLICKHOUSE_URL` in the Secret) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | turns tracing on (see below); each Deployment sets `OTEL_SERVICE_NAME=agentbazaar-<component>` |
| `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY` | Langfuse traces of LLM calls; off unless both and the Secret's `LANGFUSE_SECRET_KEY` are set |
| `LLM_FALLBACK_ADAPTER`, `LLM_FALLBACK_SMALL_MODEL`, `LLM_FALLBACK_LARGE_MODEL` | a second model provider for when `LLM_ADAPTER` fails ([ai-routing.md](../ai-routing.md)) |
| `LLM_TIER2_MAX_TOKENS`, `LLM_TIER3_MAX_TOKENS` | output-token caps per router tier (default 350) |

The scale values also give the AI service `AI_DEVICE=cuda` and `CLASSIFIER_BACKEND=hf` for GPU nodes (the models
fall back to the CPU when no GPU is visible). The service stays off until `ai.enabled`. To turn it on, also set
`CLASSIFIER_MODEL` to a licence-checked checkpoint (services/ai/MODELS.md), use an image built with the `ml` extra
and CUDA PyTorch (the published image is CPU-only), schedule it on GPU nodes (nodeSelector, tolerations,
`nvidia.com/gpu` limits), and set the API's `CLASSIFIER_ADAPTER=ai-service`.

## Gateway (APISIX)

`gateway.enabled` runs Apache APISIX 3.19 in standalone mode: routes come from the chart, with no etcd and no CRDs.
The Ingress (or the AWS target groups) send both public hosts to it.

| Host | Paths | Upstream | Limits |
| --- | --- | --- | --- |
| `PUBLIC_API_URL` host | `/mcp`, `/a2a`, `/api/v1/chat/*` | agent pool (api when it is off) | 600 req/min per token, 256 KiB bodies |
| `PUBLIC_API_URL` host | everything else | api | 1,200 req/min per token, 256 KiB bodies |
| `PUBLIC_WEB_URL` host | everything | web | 1,200 req/min per token or IP, 1 MiB bodies |

- **Per-caller limits.** `limit-count` keys on the `Authorization` header, so each agent token has its own bucket,
  and falls back to the client IP for anonymous callers. Responses carry `X-RateLimit-Limit` and
  `X-RateLimit-Remaining`; over the limit the answer is 429. Counts are per gateway replica. The app's own
  per-agent quota (the token's `qpm` claim, counted in Valkey) still applies behind the gateway. Tune with
  `gateway.rateLimit.{agents,api,web}`.
- **Body limits.** `client-control` refuses larger bodies with 413 before they reach the app
  (`gateway.maxBodySize`).
- **Client IPs.** `X-Forwarded-For` is trusted only from `gateway.trustedProxies` (private ranges by default).
- **Logs.** Access logs record method and path only: query strings can carry checkout and order tokens.
- **Read-only.** APISIX writes `nginx.conf` at start, so `conf/` (seeded from the image by an init container) and
  the nginx runtime paths are emptyDirs. The container runs as uid 636 with a read-only root filesystem.

## Agent pool (S6)

`agents.enabled` runs a second Deployment of the api image behind its own Service and HPA, so agent spikes scale and
fail apart from the storefront. The gateway, or the Ingress when there is no gateway, routes `/mcp`, `/a2a` and
`/api/v1/chat` to it. MCP is served statelessly, so no session affinity is needed.

The HPA scales on CPU (60% in scale, 3–30 replicas). Agent requests mostly wait on LLM calls, so the better signal is
request rate. With the Prometheus Operator (`serviceMonitor.enabled: true` scrapes api and agents) and
prometheus-adapter, expose it:

```yaml
# prometheus-adapter rules
rules:
  custom:
    - seriesQuery: 'agentbazaar_http_request_duration_seconds_count{namespace!="",pod!=""}'
      resources: { overrides: { namespace: { resource: namespace }, pod: { resource: pod } } }
      name: { as: agentbazaar_agent_requests_per_second }
      metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>,route=~"/mcp|/a2a|/api/v1/chat/.*"}[2m])) by (<<.GroupBy>>)'
```

and add it to the HPA next to CPU:

```yaml
agents:
  autoscaling:
    extraMetrics:
      - type: Pods
        pods:
          metric: { name: agentbazaar_agent_requests_per_second }
          target: { type: AverageValue, averageValue: '20' }
```

Without prometheus-adapter, leave `extraMetrics` empty: an HPA metric that cannot be read stops scale-down.

## Database: PgBouncer and read replicas (growth)

`pgbouncer.enabled` (on in growth) runs PgBouncer 1.26 in transaction pooling with
`ignore_startup_parameters=extra_float_digits,statement_timeout`, `server_login_retry=1` and `max_client_conn=1000`.
It reads the primary's URL from the Secret key `PGBOUNCER_DATABASE_URL`. The app's `DATABASE_URL` points at the
pooler, and the migration Job uses the direct URL because the pooler is not running yet when a pre-install hook
runs. A NetworkPolicy lets only the release's pods reach the pooler.

node-postgres sends `statement_timeout` when it connects, and PgBouncer ignores it, so set it on the role once:

```sql
ALTER ROLE agentbazaar SET statement_timeout = '15s';
```

Read replicas go in the Secret's `DATABASE_REPLICA_URLS`; `DATABASE_REPLICA_MAX_LAG_MS` (growth: 5000) decides when
reads fall back to the primary. The failover runbook is [database-failover.md](../runbooks/database-failover.md).

## Temporal workflow worker (scale)

`workflowWorker.enabled` (on in scale) runs the checkout and payment sagas. Its image is the `workflow-worker`
target of `apps/api/Dockerfile`, published as `agentbazaar-workflow-worker`: Debian slim, because Temporal's native
worker has no musl build. The image's default command is the worker. It reads the same ConfigMap and Secret as the
API (`WORKFLOW_ENGINE=temporal`, `TEMPORAL_*`). It runs 2 replicas with a PDB, spread over zones, with a 60-second
grace period so an activity can finish. It has no Service or probes. An egress NetworkPolicy limits it to DNS and
the ports in `workflowWorker.egressPorts`: Temporal, Postgres and PgBouncer, Valkey, NATS, Kafka, OpenBao,
ClickHouse and HTTPS. Temporal itself comes from its own chart or Temporal Cloud.

## PII keys and OpenBao

Lite wraps each customer's data key with `PII_MASTER_KEY`; growth wraps it with OpenBao Transit. Moving an
existing store over is a command:

```bash
kubectl -n agentbazaar exec deploy/agentbazaar-api -- node dist/cli/index.js pii rewrap   # or: pnpm --filter @agentbazaar/api cli pii rewrap
```

It moves every data key from `PII_MASTER_KEY` to the Transit key, reading each one back from OpenBao before the
row is updated. Field ciphertext is never read. It works in batches of 100 (`--batch-size`), one transaction
each, and is idempotent and resumable. It exits 0 once every key is on the Transit key's latest version, and
reports any key wrapped by a key it does not hold. Run it while the API still uses `SECRETS_ADAPTER=env` (or is
stopped), repeat until it exits 0, then switch to `PROFILE=growth`. After a Transit key rotation, the same command
re-wraps old versions inside OpenBao ([key-rotation runbook](../runbooks/key-rotation.md)).

## Identity with Keycloak

Set `IDENTITY_PROVIDER=oidc`, `OIDC_ISSUER_URL=https://<keycloak>/realms/<realm>` and `OIDC_AUDIENCE`
(default `agentbazaar-api`). In the realm:

- give the people's client and the agent clients an **audience mapper** that adds `agentbazaar-api` to access
  tokens; tokens for any other audience are refused;
- make the agent scopes `catalog:read`, `quote:create` and `order:create` client scopes (included in the token
  scope) and attach them to each agent client; agents use client credentials and their service-account user
  carries the realm role `agent`;
- give administrators the realm role `admin`. Admin routes also need an MFA session, which the API reads from
  `amr` (`otp`/`mfa`) or `acr=mfa`, so add Keycloak's AMR mapper and an OTP step to the admin login flow.

Signing-key rotation needs nothing on the API side: it fetches the realm's JWKS and refetches it, at most once
every 30 seconds, when a token arrives with an unknown key id. The OIDC suite
([`apps/api/test/services/keycloak.spec.ts`](../../apps/api/test/services/keycloak.spec.ts), realm in
`keycloak/t6-agentbazaar-realm.json`) runs against Keycloak 26.8 in the Keycloak workflow.

## Tracing (OpenTelemetry)

Set `config.OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. `http://otel-collector:4318`) and the API starts the OpenTelemetry
Node SDK before it loads the app. Without it, the SDK is never imported. It sends traces only, over OTLP/HTTP
protobuf; metrics stay on Prometheus `/metrics`. The other standard variables (`OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`) work as usual.

- **Spans:** incoming HTTP (named by route, e.g. `GET /api/v1/orders/:id`), Fastify request handling, Postgres
  queries (inside a request only) and outgoing `fetch` calls (OpenBao, Meilisearch, payment gateways). Probes and
  `/metrics` are not traced.
- **Never recorded:** SQL parameters (query text only), request and response bodies, and headers. Query-string
  values are replaced with `REDACTED`, and the caller's IP is dropped from server spans. Every string attribute,
  exception message and status message passes through the same PII redaction as the logs (email, phone, card,
  Aadhaar, PAN, UPI).
- **Logs:** pino lines written inside a span carry `trace_id` and `span_id`.

## Policies (OPA with conftest)

Every chart and Terraform change runs the policies in [`deploy/policies`](../../deploy/policies) in the IaC
workflow:

```bash
conftest verify --policy deploy/policies/kubernetes            # policy unit tests
conftest verify --policy deploy/policies/terraform
helm template agentbazaar deploy/helm/agentbazaar -f deploy/helm/agentbazaar/values-growth.yaml > rendered.yaml
conftest test --combine --policy deploy/policies/kubernetes rendered.yaml
```

- **Kubernetes** (rendered chart, all three values files): non-root, no uid 0, read-only root filesystem, no
  privilege escalation or privileged mode, all capabilities dropped (only `NET_BIND_SERVICE` may be added),
  requests and limits for CPU and memory, readiness and liveness probes on containers that serve traffic, images
  pinned to a tag other than `latest` or to a digest, and a NetworkPolicy selecting every workload's pods.
- **Terraform** (plan JSON for lite, growth and scale): no public database (RDS, Aurora, OpenSearch outside a VPC,
  public MSK). Encryption at rest for RDS, Aurora, EBS, ElastiCache, OpenSearch, instance and launch-template
  volumes, SQS and SNS. Every S3 bucket has encryption and a public access block with all four flags on, and no
  public ACLs. Every AWS provider sets `default_tags` with Project, Environment, Profile and ManagedBy. IAM has no
  `*` or `service:*` actions, no `NotAction`/`NotResource`, no unconditioned `Resource: "*"` on anything but
  Describe/List/Get, and no AdministratorAccess-style managed policies. The plan JSON comes from the plan that
  `tofu test -json -verbose` makes against the mocked AWS provider, so no cloud credentials are needed.

## Fresh-cluster test

[`.github/workflows/cluster.yml`](../../.github/workflows/cluster.yml) proves a fresh install works. It runs on chart,
cluster-test and demo changes on main, nightly and on demand. It creates a k3d cluster (k3s 1.35 with Traefik,
metrics-server and network policies enforced), builds and imports the api and web images, and starts the
dependencies. It installs the chart with `values-growth.yaml` plus the gateway, PgBouncer and agent pool, then
seeds a catalog and runs:

1. the smoke suite ([`tests/cluster/smoke.sh`](../../tests/cluster/smoke.sh)): health, readiness, storefront,
   catalog, Meilisearch search, agent card, gateway rate-limit headers and a 413 on a 300 KB body;
2. the end-to-end sale ([`apps/demo/src/cluster-e2e.ts`](../../apps/demo/src/cluster-e2e.ts)): the scripted buyer
   agent from `packages/testkit` gets a client-credentials token, then searches, haggles, accepts and creates a
   checkout link over MCP through the gateway. A human then confirms the address and pays with the mock gateway,
   and the order must reach `paid`;
3. a routing check: the agent pool's `/metrics` must show the MCP requests and the api's none;
4. a tracing check: tracing is on (`OTEL_EXPORTER_OTLP_ENDPOINT` points at a test collector that prints every
   span). The spans must come from both services, carry the `/mcp` route and Postgres queries, and show
   `url.query` as `t=REDACTED`. They must not contain the buyer's email or phone, or any token.

To run it on your machine with Docker and k3d, follow the workflow's steps; the cluster is called `ab-t6` and
listens on port 18080.

### Results

On GitHub's `ubuntu-latest` runner (4 vCPU, 16 GB), k3s v1.35.9 in k3d 5.9.0, Helm 4:

| Run | Commit | Wall time | Result |
| --- | --- | --- | --- |
| [42202548657](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42202548657) | `4f3717b` | 3 min 37 s | 9/9 smoke checks; buyer agent negotiated ₹5,499 down to ₹5,060 in four counters, order AB-1001 paid; 11 MCP requests on the agent pool, 0 on api |
| [42203992337](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42203992337) | `b8745e0` | 3 min 45 s | the same, with tracing on: 548 spans from api and agents, with the `/mcp` route, Postgres queries and `t=REDACTED`; no email, phone or token |

The install itself (migration Job, rollout of the gateway, PgBouncer, 2 api, 2 agents and 2 web pods) took
15 seconds once the images were in the cluster; building the two images took under two minutes.
