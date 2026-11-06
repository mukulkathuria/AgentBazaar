# ADR 0009: Route chosen reads to streaming replicas, with read-your-writes by WAL position

- Status: Accepted
- Date: 2026-11-06
- Deciders: Mukul Kathuria

## Context

The growth profile (milestone G3) adds streaming read replicas and PgBouncer. Physical replicas are asynchronous, so a read there can return data that is a few milliseconds, or after an incident many seconds, old. Two requirements follow:

- A principal (a signed-in customer, an admin, an agent client or an anonymous caller) that has just changed something must see the change on its next read: read-your-writes. An admin who saves a product and reloads the page must not see the old product.
- Nothing that decides money, stock, quotes or authentication may ever read stale data.

The API reads and writes through one `DB` executor in every repository, the lite profile must not change, and several API instances sit behind a load balancer, so a principal's next request can reach a different instance.

## Decision

- **Opt in per call site.** A second executor, `READ_DB`, serves only explicitly chosen safe reads: product pages, categories, the product feed, product summaries, Postgres search queries, product-graph lookups and the analytics dashboards. Quotes, prices used at checkout, stock reservations, carts, orders, payments, identity, sessions, idempotency keys, the outbox and jobs stay on `DB`, the primary. Without `DATABASE_REPLICA_URLS`, `READ_DB` is `DB` itself, so lite and single-database deployments behave exactly as before.
- **Only GET and HEAD requests read from a replica.** The router sees the request a read belongs to through `AsyncLocalStorage`, entered in a Fastify `preHandler` hook. Reads outside a request (jobs, consumers, the CLI) and reads in mutating requests (POST, PUT, PATCH, DELETE, which includes every MCP and A2A call) run on the primary, so a request always reads its own writes. A transaction opened on `READ_DB` (Postgres search sets a transaction-local similarity threshold) runs whole on the chosen server; a transaction opened on `DB` never touches a replica.
- **Read-your-writes by WAL position.** Before the response to a mutating request is sent (Fastify `onSend`), the API reads the primary's `pg_current_wal_insert_lsn()` and stores it for the principal in the shared cache with an atomic maximum (`Cache.setMax`, a Lua script on Valkey), so concurrent requests never lower it and every API instance sees it. A later GET by that principal may use a replica only if the replica's `pg_last_wal_replay_lsn()` from the last health check has reached that position; otherwise it reads the primary.
  - The insert position, not the flush position: with `synchronous_commit=off` a commit is acknowledged before its WAL is flushed, and the insert position already covers it.
  - A 24-byte allowance for a WAL page header: an idle primary's insert position can sit just past a page header that replay never reports as reached. Every commit record is longer than a page header, so the allowance cannot hide an unreplayed commit.
  - If the position or the record cannot be read, the router behaves as if the principal had just written: it reads the primary, which is never stale.
  - A record lives for the lag limit plus 60 seconds. Any replica still behind it by then lags more than the limit and is out of rotation.
- **Health and lag.** A check every `min(1 s, DATABASE_REPLICA_MAX_LAG_MS / 4)` samples the primary's insert position and each replica's state. A replica's lag is the time since the newest primary sample it has replayed: an upper bound, accurate to one check interval, that also catches a replica whose replication connection has silently broken (its own replay timestamps would look current). A replica is out of rotation while it is unreachable, no longer in recovery (promoted, possibly on a diverged timeline) or lagging more than `DATABASE_REPLICA_MAX_LAG_MS` (default 5000), and back in once a check finds it caught up. Replicas start out of rotation until their first check. A read that fails on a replica is retried once on the primary; a broken connection (as opposed to an SQL error) also takes the replica out until its next check.
- **Metrics.** `agentbazaar_db_reads_total{route}` (`replica`, `primary_write_path`, `primary_no_replica`, `primary_read_your_writes`, `primary_fallback`), `agentbazaar_db_replica_lag_seconds{replica}` and `agentbazaar_db_replica_healthy{replica}`. Replicas are labelled by host and port, never with credentials.
- **PgBouncer in transaction-pooling mode** sits in front of the primary. The API keeps no session state across transactions: advisory locks are transaction-scoped, settings use `set_config(..., true)`, node-postgres uses unnamed prepared statements, and there is no `LISTEN`/`NOTIFY`, temporary table or `WITH HOLD` cursor. node-postgres sends `statement_timeout` as a startup parameter, which PgBouncer cannot track per client, so PgBouncer ignores it (`ignore_startup_parameters`) and the timeout is set on the database role instead.

## Consequences

- Storefront, crawler and dashboard GET traffic moves to replicas; checkout, payments, quotes and auth never read stale data; lite is unchanged.
- Read-your-writes holds across any number of API instances, because the positions live in the shared cache. With replicas configured the cache becomes part of read correctness, and when it is unreachable the router falls back to the primary.
- Each mutating request costs one extra primary round trip and one cache write, and each GET that makes routed reads costs one cache read, only when replicas are configured.
- Agent traffic reads from the primary, because MCP and A2A calls are POSTs. Routing read-only tools to replicas is a later optimisation.
- Read-your-writes covers writes made by mutating requests. A GET that records an analytics event as a side effect (search telemetry) is not covered, and read models updated by outbox consumers (the search index) are eventually consistent even on the primary.
- Read-your-writes is per principal. Anonymous callers are identified by IP address (callers sharing an address share a record, which only sends more reads to the primary), and a caller that signs in becomes a new principal.

## Alternatives considered

- **A sticky-primary window after each write** (Rails' database selector, for example): no extra queries, but correct only while lag stays below the window, which is exactly when it is not needed.
- **drizzle-orm's `withReplicas`:** routes query-builder selects at random and every raw `execute` to the primary (this codebase uses raw SQL throughout), with no lag handling or read-your-writes.
- **A consistency token returned to the client** (as some managed databases do with session tokens): needs every client to echo it; agents and crawlers would not.
- **Synchronous replication with `remote_apply` to every replica:** no stale reads, but every commit waits for every replica, and one slow or lost replica stalls writes.
- **Waiting on the replica until it reaches the principal's position:** adds read latency exactly when a replica is behind; reading the primary is simpler and faster.
- **Pgpool-II read/write splitting:** cannot know which reads are safe or who wrote what, and adds another stateful component to operate.
