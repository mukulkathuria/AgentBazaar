# Changelog

All notable changes to AgentBazaar are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version may contain breaking changes; they are listed under **Changed** with a migration note.

## [0.9.0] - Unreleased

The lite release candidate: a complete, agent-ready store on one VPS. The date is set when `v0.9.0` is tagged, after the release gates pass and the evidence report is approved.

### Added

- **Monorepo foundations.** pnpm 12 and Turborepo workspaces, TypeScript 6 in strict mode, ESLint with complexity and size limits, dependency-cruiser module boundaries, Prettier, conventional commits.
- **Profiles.** `PROFILE=lite|growth|scale` selects adapters at startup; `packages/config` validates every variable and reports all problems at once, exiting with code 78 instead of starting half-configured.
- **Contracts.** Zod schemas shared by REST, MCP tools, A2A parts, the web app and the AI service; generated OpenAPI and JSON Schemas with a `--check` mode in CI.
- **Data layer.** Fifteen forward-only SQL migrations, a checksum-verifying migrator under an advisory lock, PostgreSQL and embedded PGlite drivers, a transactional outbox with idempotent consumers, and a Postgres-locked job scheduler. NATS JetStream and Kafka event-bus adapters for growth and scale.
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

### Security

- The pricing engine, quote signing, payment webhooks, PII handling and the agent surface have not yet had an independent penetration test. Do not take real payments until one is done.

[0.9.0]: https://github.com/mukulkathuria/AgentBazaar/commits/main
