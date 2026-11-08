# Changelog

All notable changes to AgentBazaar are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version may contain breaking changes; they are listed under **Changed** with a migration note.

## [0.9.0] - Unreleased

The lite release candidate: a complete, agent-ready store on one VPS. It also carries the growth and scale profiles (milestones G1 to G5 and S1 to S6), built and verified in CI; the plan tags them `v0.95` and `v1.0` once their remaining runs on real infrastructure pass. The date is set when `v0.9.0` is tagged, after the release gates pass and the evidence report is approved.

### Added

- **Monorepo foundations.** pnpm 12 and Turborepo workspaces, TypeScript 6 in strict mode, ESLint with complexity and size limits, dependency-cruiser module boundaries, Prettier, conventional commits.
- **Profiles.** `PROFILE=lite|growth|scale` selects adapters at startup; `packages/config` validates every variable and reports all problems at once, exiting with code 78 instead of starting half-configured.
- **Contracts.** Zod schemas shared by REST, MCP tools, A2A parts, the web app and the AI service; generated OpenAPI and JSON Schemas with a `--check` mode in CI.
- **Data layer.** Forward-only SQL migrations, a checksum-verifying migrator under an advisory lock, PostgreSQL and embedded PGlite drivers, a transactional outbox with idempotent consumers, and a Postgres-locked job scheduler. NATS JetStream and Kafka event-bus adapters for growth and scale.
- **Catalog and search.** Products, variants, `ltree` categories and attribute schemas; floors from landed cost and minimum margin; an MRP check constraint. Hybrid search over Postgres full-text, trigram and pgvector fused with reciprocal rank fusion, deterministic hash embeddings identical in TypeScript and Python, golden-query regression tests and a 10,000-product latency benchmark.
- **Customization.** Text fields and catalog designs only, no uploads. Validation rejects homoglyphs, bidirectional overrides, zero-width characters, emoji, markup and prompt-injection phrasing in English and Hinglish; blocklist and trademark words go to a human review queue.
- **Inventory, cart, checkout and orders.** Atomic reservations that cannot oversell, checkout sessions that lock prices from a cart or a signed quote, an order state machine with an append-only event log, cash on delivery, returns and refunds.
- **Pricing policy engine.** Price bands, guarded floors, a Boulware concession ladder, volume trades, a negotiation state machine, signed single-use expiring quotes and a human approval queue for large discounts, with fast-check property tests proving no offer sequence prices at or below the floor.
- **Payments.** A `PaymentPort` with a `mock` adapter (default, used by the demo and tests), a `razorpay` adapter (unit-tested against recorded fixtures, not yet verified against Razorpay's live sandbox) and an experimental `youpi-pg` adapter. Webhooks are verified on the raw body, deduplicated by event ID and applied forward only; amount mismatches return 409.
- **GST.** Per-line CGST and SGST or IGST from tax-inclusive prices with exact paise sums, gap-free invoice numbers per financial year, and illustrative seed rates.
- **Identity.** A built-in EdDSA token issuer for customers and agent clients, an OIDC verifier for Keycloak or any OIDC issuer, OAuth client credentials with `catalog:read`, `quote:create` and `order:create` scopes, per-agent quotas, and admin endpoints that require an MFA-verified session.
- **PII vault and DPDP features.** Per-customer envelope encryption (AES-256-GCM) in a separate `pii` schema, HMAC blind indexes, consent records with the notice version, data export, erasure by crypto-shredding, a retention sweep, and an OpenBao Transit key wrapper for growth and scale.
- **Agent layer.** An MCP server over streamable HTTP with 12 tools, an A2A endpoint (A2A 1.0 and 0.3) with an Agent Card, and a chat API with streaming. A router that can only escalate or deny, an output guard that rejects model replies containing numbers the services did not produce, per-intent output limits, and per-session token and cost budgets. LLM adapters: `template` (default, no keys), `anthropic` and `openai-compatible`.
- **AI service.** An optional FastAPI service with an English, Hindi and Hinglish rules classifier, hash embeddings and regex PII redaction, plus opt-in Hugging Face, sentence-transformers and Presidio backends.
- **Audit and observability.** An append-only audit log and redacted LLM traces, PII redaction for logs, Prometheus metrics, health and readiness endpoints, and GEO analytics for AI-crawler hits and AI referrals.
- **Deployment.** Docker Compose profiles (`demo`, `lite`, `growth`, `scale`, `observability`, `ai`), Caddy as the edge, hardened container settings, a Helm chart with growth and scale values, and OpenTofu/Terraform modules for AWS.
- **CI.** Build, lint, types, unit, integration and end-to-end tests on both PostgreSQL and PGlite; gitleaks, Semgrep, OSV-Scanner, Trivy and a licence gate; a Docker demo smoke test with a k6 run; signed release images with SBOMs; and a job that runs the README quickstart.
- **Documentation.** README, contributing guide, governance, security policy, Code of Conduct, architecture decision records, threat model, OWASP ASVS mapping, DPDP compliance pack with draft legal templates, runbooks, benchmark method and launch kit.

**Phase 1 release gates**

- **Browser journeys and accessibility.** Playwright journeys (shopping, search, a chat haggle, returns, account export and erasure, admin sign-in with TOTP, keyboard only, Hindi, slow and offline networks, no JavaScript) on Chromium for every push and on Chromium, Firefox, WebKit, Pixel 7 and iPhone 15 nightly; axe on 10 page states in English and Hindi; four screenshot baselines. `scripts/e2e-stack.sh` starts the production builds on PGlite with an MFA admin.
- **Lighthouse CI budgets** for the home, category, product and search pages: performance at least 0.90, LCP at most 3.0 s, TBT at most 300 ms, CLS at most 0.05, JavaScript at most 180 kB.
- **API fuzzing and DAST.** Schemathesis over all 54 REST operations (shopper, admin and erasure passes; a fixed seed on pushes, fresh seeds nightly) and an OWASP ZAP baseline of the web app and the API that fails on any untriaged High alert.
- **Failure injection.** Postgres and Valkey outages through Toxiproxy, and payment, AI-service and model upstreams that fail, reset or hang (`apps/api/test/services/resilience.spec.ts`).
- **LLM evals.** promptfoo chat and MCP suites (a core set on every push, the full set nightly) and garak injection probes behind a zero-success gate.
- **Coverage and mutation gates.** One merged coverage measurement of the unit, integration and end-to-end suites (85% lines and 80% branches on domain and application code), coverage gates for config, contracts and the AI service, a StrykerJS gate of 80% on pricing, quote signing, inventory and the order state machine on every push, and a nightly seven-shard run gated at 70% on all domain and application code (73.91% at `f688714`).
- **Upgrade test.** A database seeded by the previous release is migrated and must still serve health, catalog, search, an old customer's sign-in and order history, and a new checkout.
- **Soak tooling.** `tests/load/soak-monitor.mjs` samples memory, connections and the outbox every minute and fails a run that grows after warm-up; a 5-hour soak runs weekly in CI.
- **Real-service test stack.** `tests/infra/docker-compose.yml` with eleven services and a `services` Vitest project, run by the Services workflow on every push.

**Growth profile (G1 to G5)**

- **Meilisearch search (G1)**, fed from the outbox, with `cli reindex` writing pages of 500 products; a reviewed Hindi term map, so queries in Devanagari find catalog products in every engine; a 66-query golden set and a 100,000-product benchmark.
- **NATS JetStream (G2)** with idempotent consumers.
- **Data tier (G3).** Read replicas for safe GET reads with read-your-writes by WAL position (`DATABASE_REPLICA_URLS`, `DATABASE_REPLICA_MAX_LAG_MS`), lag checks and replica metrics, PgBouncer 1.26 in transaction pooling (Compose `growth` profile and Helm), and an automated failover drill ([ADR 0009](docs/adr/0009-replica-routing-and-read-your-writes.md)).
- **Platform (G4).** Growth Helm values with an APISIX 3.19 gateway in standalone mode, PgBouncer and autoscaling; `cli pii rewrap` to move PII data keys onto OpenBao Transit (`OPENBAO_TRANSIT_MOUNT`); Keycloak OIDC setup and suite; OPA/conftest policies for the chart and the Terraform plans; OpenTelemetry tracing with redaction, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; a fresh-cluster test on k3d ([ADR 0015](docs/adr/0015-growth-platform-on-kubernetes.md)).
- **AI efficiency (G5).** Model routing with per-tier output caps (`LLM_TIER2_MAX_TOKENS`, `LLM_TIER3_MAX_TOKENS`) and a fallback provider (`LLM_FALLBACK_ADAPTER`, `LLM_FALLBACK_SMALL_MODEL`, `LLM_FALLBACK_LARGE_MODEL`); a semantic cache that stores number-free templates (`SEMANTIC_CACHE`, `SEMANTIC_CACHE_THRESHOLD`); an observer gated on risk signals with a large-model judge; Langfuse tracing through its OpenTelemetry endpoint (`LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`); `AI_DEVICE` for GPU backends in the AI service; migration 0060 records each model call's kind ([ADR 0012](docs/adr/0012-semantic-cache-and-observer-gating.md)).

**Scale profile (S1 to S6)**

- **Kafka (S1)** with the outbox relay, ordered per key, with replay and read-model rebuild tests.
- **OpenSearch and Qdrant (S2)** with whole-SKU tokens, payload indexes on filtered fields, and a total order ending on the product id on every engine path.
- **Data scale (S3).** The seven append-only event logs are range-partitioned by UTC month (migrations 0050 and 0051), with an hourly job that keeps partitions ahead; `cli archive` moves old months to verified gzip JSON-lines files in `ARCHIVE_DIR`, with a Helm CronJob; a data-scale suite for 1M, 10M and 100M order events ([ADR 0013](docs/adr/0013-time-partitioned-event-logs.md)).
- **Sagas (S4).** Checkout and payment as a Temporal saga behind `WORKFLOW_ENGINE=temporal` (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`), run by `cli workflow-worker` from the new `workflow-worker` image, with a crash suite that kills the worker at every step ([ADR 0010](docs/adr/0010-checkout-sagas-on-temporal.md)).
- **Platform at scale (S5).** ClickHouse analytics fed from the outbox (`ANALYTICS_ADAPTER`, `CLICKHOUSE_URL`); AWS WAF with Bot Control on the storefront host, rate rules and a partner allow-list; Wazuh decoders and rules for the API's security events; the scale k6 profile and an AWS FIS zone-failure template, off by default ([ADR 0014](docs/adr/0014-platform-at-scale-analytics-edge-siem.md)).
- **Agent pool (S6).** A separate Deployment and autoscaler for `/mcp`, `/a2a` and `/api/v1/chat`, and an agent-spike k6 profile with latency and cost budgets.

### Changed

- **Breaking for lite: set `CROWDSEC_BOUNCER_KEY` in `.env`.** Caddy is now built with the Coraza WAF and the CrowdSec bouncer and refuses to start without the key. Generate one with `openssl rand -hex 32`.
- **OpenSearch indexes created before `4aa12b7` and `074c55a` must be rebuilt.** They keep their old mapping (split SKUs, no id sort key): delete the index and run `cli reindex`.
- **Migration 0051 locks the event tables while it copies them into partitions**, about 25 to 37 s per million order events on a laptop. Large installs should upgrade in a maintenance window.
- **Behind PgBouncer, set `statement_timeout` on the database role** (`ALTER ROLE agentbazaar SET statement_timeout = '15s';`): PgBouncer in transaction pooling ignores the client's startup parameter.
- **`LlmPort` gained `judge()`.** Third-party LLM adapters must implement it; like `compose()`, it must never throw.
- **Personal-data requests count toward the repeated-injection hand-off.** A request for another customer's details is now an injection attempt, refused without a model call, and a second one in the same chat hands the session to a person.
- **Search engines and the AI service are called over `node:http(s)`** with kept-alive connections instead of Node's `fetch`, which stalled about 40 ms on Meilisearch's chunked answers.

### Fixed

- **Lite Postgres data now lives in the `pgdata` volume.** pg18 images keep the data directory at `/var/lib/postgresql/18/docker`, but Compose mounted `pgdata` at `/var/lib/postgresql/data`, so the database sat in an anonymous volume and was lost when the container was recreated. If you ran the lite profile from an earlier commit, take a `pg_dump` (see `docs/runbooks/backup-restore.md`) before upgrading, then restore it into the new volume.
- **Resilience** (found by failure injection). A database or cache outage answers 503 instead of 500; a connection dropped mid-transaction no longer crashes the process; a black-holed database no longer hangs requests; a pooled connection whose `BEGIN` failed is released instead of draining the pool; an `Idempotency-Key` left "in progress" by a failed request is released after a 60-second lease.
- **API contract** (found by Schemathesis). A NUL character in any input answers 400 instead of 500; long path parameters get the API's error envelope; two POST routes answer the documented 200; carts and quotes above the ₹1 crore contract cap are refused; the OpenAPI document carries the password and `Idempotency-Key` rules.
- **Storefront and admin** (found by the browser journeys). `GET /api/v1/admin/dashboard` is implemented, so the admin console's landing page works; a just-paid order no longer reads "Awaiting payment"; pages keep their `<title>` after a language switch; Safari keeps the plain-HTTP demo's cookies; seeded products keep the same ids on every boot, so tied results keep their order.
- **Search and messaging** (found by the real engines). Meilisearch rejecting every search (facets on fields that were not filterable), its 1,000-hit cap, hybrid hits for gibberish and a p95 over a second from `rankingScoreThreshold`; exact SKUs falling out of the top 10 in Postgres and OpenSearch; OpenSearch splitting SKUs into words; Qdrant timeouts while creating collections; tied scores without a total order, which could repeat or skip a product between pages; the outbox delivering one aggregate's events out of commit order (migration 0080); the Kafka consumer not restarting after close.
- **Data.** Order history no longer reads the whole `orders` table at scale (an index on `subject`, migration 0052); an offer that arrives after a negotiation lapsed keeps the negotiation expired.
- **PII detection.** The Aadhaar detector checks the Verhoeff digit, and digits inside UUIDs are no longer read as phone or Aadhaar numbers, in TypeScript and in the AI service.
- **Agent** (found by the evals). The rules classifier recognises all 20 corpus attacks, refuses personal-data requests instead of searching for them, and treats "thoda aur kam karo" as an offer that moves the haggle one step.
- **CI.** The licence gate checks every workspace's production dependencies; it had been checking none.

### Security

- The pricing engine, quote signing, payment webhooks, PII handling and the agent surface have not yet had an independent penetration test. Do not take real payments until one is done.
- **Edge WAF for lite.** Caddy with Coraza (OWASP CRS 4.25, paranoia level 1, blocking) and CrowdSec, which bans addresses that brute-force sign-in. The SQL-injection rules skip free-text JSON fields (chat, offer messages, personalisation text); that is safe only while every query stays parameterised.
- **ZAP findings fixed:** sign-in and registration forms that put credentials in the URL before hydration, `style-src 'unsafe-inline'` in the CSP, and a missing `Cross-Origin-Resource-Policy` header.
- **Supply chain.** Dependency review and an SBOM diff on manifest changes (dependency review enforces once the repository's Dependency graph is on); the release SBOM now lists the npm packages (561, where it listed 15); the `workflow-worker` image is published and signed with the others.
- **SIEM.** Wazuh rules for refused requests, sign-in brute force, token guessing, forged webhooks, prompt injection, floor probing, erasures and privileged changes.
- **Tracing.** Spans never carry SQL parameters, bodies or headers; query-string values are redacted, and every attribute passes the PII redaction the logs use.

[0.9.0]: https://github.com/mukulkathuria/AgentBazaar/commits/main
