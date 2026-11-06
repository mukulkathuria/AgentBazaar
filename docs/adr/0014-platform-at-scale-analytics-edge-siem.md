# ADR 0014: Platform at scale: ClickHouse analytics from the outbox, a layered edge, Wazuh as a separate service

- Status: Accepted
- Date: 2026-11-06
- Deciders: Mukul Kathuria

## Context

Milestone S5 adds what the store needs at about 10 lakh registered users: analytics that do not load the
transactional database, bot management and per-agent limits at the edge, a SIEM, and proof (a load profile and a
zone-failure drill). The lite profile was also missing its planned edge WAF (Caddy, CrowdSec, OWASP CRS). Three
constraints shape the choices: lite must keep working with no extra services, every runtime component must be open
source with a licence the gate accepts, and agents are customers, so anything that blocks "bots" must not block them.

## Decision

**Analytics in ClickHouse, fed from the outbox.** `AnalyticsService` writes through an `AnalyticsStore` port.
Postgres stays the default in every profile; `ANALYTICS_ADAPTER=clickhouse` makes `track()` append an
`analytics.recorded` outbox event in the caller's transaction, and an idempotent consumer inserts it into ClickHouse
over the HTTP interface with plain `fetch` (no client library: four small calls do not earn a dependency). The outbox
event id is the dedupe key twice over: `insert_deduplication_token` skips a redelivery inside the deduplication
window, and `ReplacingMergeTree` ordered by `(kind, at, id)` collapses anything later; dashboards read with `FINAL`, so
counts are exact before merges. Tables are partitioned by month with a 13-month TTL. DDL lives in
`apps/api/migrations/clickhouse` and a forward-only runner of about 30 lines applies it lazily (idempotent statements,
since ClickHouse has neither transactional DDL nor advisory locks). Both stores answer the dashboard queries
identically for the same events, ties included (byte order in both).

**A layered edge.**
- *Lite:* Caddy built with xcaddy, the Coraza WAF running the OWASP Core Rule Set 4 in blocking mode at paranoia
  level 1, and the CrowdSec bouncer; a CrowdSec agent reads Caddy's JSON access log and bans abusive addresses
  (hub scenarios plus our sign-in brute-force scenario). Three documented exclusions keep the API usable: PUT, PATCH
  and DELETE allowed; payment webhooks scored but not blocked (their HMAC is checked first by the API); SQL-injection
  rules skip only the free-text JSON fields buyers and agents write (chat text, offer messages, personalisation
  text), which the API never puts into SQL. Response bodies are not buffered, so SSE streams keep working.
- *Scale:* AWS WAF Bot Control scoped to the **storefront host only**, with AI crawlers and HTTP-library clients
  counted and then throttled per bot name and address rather than blocked; rate-based rules per address, on the
  sign-in endpoints and per bearer token (all answering 429 so agents back off); and an IPv4 allow-list for verified
  partner agents that exempts them from the per-address limit only. The API's per-agent quotas stay the precise
  limit; the edge rules are backstops.

**Wazuh as a separate service.** The API logs one JSON line per security event (`sec` field: refused requests,
prompt-injection flags, audit records including erasure and far-below-floor offers). The repository ships only Wazuh
configuration (decoders, rules, a Fluent Bit shipping example) and tests it with `wazuh-logtest`; Wazuh (GPL-2.0) is
never linked or bundled. The API records facts; patterns over time (brute force, floor probing, runaway agents) are
Wazuh frequency rules, so thresholds change without a release.

**Proof that needs real AWS stays opt-in.** The scale k6 profile and an AWS FIS zone-failure template (subnet
connectivity, node stop, database and cache failover, a 1% 5xx stop alarm; every target named by ARN or cluster tag)
are in the repository and tested without AWS; running them is a human decision with the cost in the runbook.

## Consequences

- Lite is unchanged except the edge: Caddy is now built from `deploy/compose/caddy`, and the stack needs
  `CROWDSEC_BOUNCER_KEY`; Caddy refuses to start without it.
- In ClickHouse mode analytics events go through the outbox: dashboards lag the relay by a moment, and the outbox
  carries more rows (its pruning job matters more). A ClickHouse outage delays analytics; the consumer retries.
- `FINAL` costs some query time; with monthly partitions and a 30-day window it reads one or two partitions.
- The WAF exclusions are a deliberate trade: free-text fields lose SQL-injection inspection (not XSS or the rest),
  which is safe only while the API keeps parameterised queries everywhere.
- Bot Control is priced per request and its counted categories need watching in the WAF metrics.
- The S5 definition of done (load profile and zone drill pass) is not met until the runbook is executed.

## Alternatives considered

- **ClickHouse as the only analytics store from growth on:** simpler reads, but lite would need it too or lose
  dashboards; the port keeps lite at zero extra services.
- **The official ClickHouse JS client:** Apache-2.0 and capable, but a dependency for four HTTP calls.
- **Deduplicating with `uniqExact(id)` instead of ReplacingMergeTree + FINAL:** exact without merges but holds every
  id in memory per query; worse at scale.
- **ModSecurity (with nginx or Apache):** the reference CRS engine, but Trustwave ended its support in 2024 (the
  project moved to OWASP) and it would put a second web server in front of Caddy; Coraza is a CRS-compatible Go engine
  that plugs straight into Caddy.
- **Bot Control on every host:** would block agents' HTTP clients and AI crawlers, the store's customers and GEO.
- **Elastic Security or OpenSearch Security Analytics as the SIEM:** Elastic's licence is refused by the gate;
  OpenSearch is possible but the plan names Wazuh, which also brings agents, FIM and compliance mapping.
