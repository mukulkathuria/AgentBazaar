# ADR 0013: Partition the event logs by month, archive whole months, and keep orders in one table

- Status: Accepted
- Date: 2026-11-06
- Deciders: Mukul Kathuria

## Context

Milestone S3 of the plan asks for "time partitioning of orders and events, archival, optional per-module databases",
done when "query plans stay stable at 100 million order events".

Seven tables only ever grow: `order_events`, `outbox_events` (kept after publishing), `processed_events`,
`webhook_events`, `analytics_events`, `audit_log` and `llm_traces`. Three of them reject `UPDATE` and `DELETE`
through the `forbid_mutation()` trigger, so the application cannot prune them, and a row-by-row `DELETE` on a
table of hundreds of millions of rows bloats it and loads autovacuum for hours anyway. The
[retention schedule](../compliance/retention-schedule.md) listed their archival as planned.

Constraints:

- PGlite (the demo, the tests) must keep working with no extension: no pg_partman, no TimescaleDB.
- On a partitioned table every primary key and unique constraint must include the partition key. Two
  deduplications depended on such keys: consumers claim `(consumer, event_id)` in `processed_events`, and
  webhooks claim `(provider, event_id)` in `webhook_events`.
- DPDP erasure is crypto-shredding: personal data lives only in the `pii` schema, encrypted with a per-customer
  key that erasure deletes ([data map](../compliance/data-map.md)). Archives must not keep anything that erasure
  would have removed.

## Decision

**Monthly range partitions for the seven event logs** (migrations 0050 and 0051). Each table is partitioned by its
time column on UTC calendar months, `<table>_pYYYYMM`, with a `<table>_default` partition that catches anything
outside them. Primary keys gain the time column, for example `order_events (id, created_at)`. The conversion keeps
every column, default, check, identity column, index and id sequence, so it also works on a database where later
migrations (0060, 0080) already ran.

- The two deduplications take a transaction-scoped advisory lock on the key, then insert only if no partition
  holds it (`NOT EXISTS`). Postgres cannot enforce uniqueness across partitions; the lock makes the
  check-then-insert atomic, and a test races four deliveries of one event.
- Queries that can bound time do so, so Postgres skips old partitions. The outbox relay updates rows by
  `(id, created_at)`, with `created_at` read back as text, exact to the microsecond. Order history adds
  `created_at >= min(order.created_at) - 1 day`, since no event predates its order.
- `order_events` is indexed on `(order_id)` instead of `(order_id, id)`, so an order's few events share one
  deduplicated B-tree entry instead of one entry each.

**Partition maintenance.** `ensure_month_partitions(table, months_ahead, first_month)`, a PL/pgSQL function,
creates missing months. If rows already landed in the default partition for a month, it detaches the default,
creates the month, moves the rows, and attaches the default again. Detaching drops the default's copy of the
append-only trigger, which is what lets the rows move. A scheduler job (`db.partition-maintenance`, hourly,
`lock_timeout` 5 s) keeps three months ahead. A month whose partition is missing therefore only costs pruning,
never an error, and the next run repairs it.

**Archival** (`cli archive`). Partitions of months before a cutoff are detached, written as gzip JSON lines to
`ARCHIVE_DIR` and read back. Row count and an order-independent checksum, the sum of the first 60 bits of each
line's SHA-256, must match the table, computed independently by Postgres. Only then is the table dropped. The
cutoff is `--before YYYY-MM` or a rolling `--older-than MONTHS`, which the Helm CronJob uses with 13 months.

- The command is idempotent. A partition left detached by an interrupted run is picked up again.
- Outbox partitions that still hold unpublished events are skipped.
- The current month can never be archived.
- Archival is not deletion: the files are the record. Retention of the files is the operator's decision, per
  table, with counsel ([runbook](../runbooks/archive.md)).

**DPDP.** Event rows carry tokens (`cus_...`, `customer:<token>` subjects), never names or contact details. A test
buys with a known name, email, phone and address, archives, and checks the archive contains the token and none
of those values. After erasure, the token in an archive points at a crypto-shredded record, so archives never
need rewriting. Backups remain the exception they already were.

**Orders stay in one table.** `orders` is the target of foreign keys (`order_lines`, `order_events`,
`return_requests`), is looked up by `id` and `number` with no time in the query, and rows change state for
weeks. Partitioning it would put `created_at` into every key and every referencing foreign key, and turn each
lookup into a probe of every partition. Orders are also a fraction of their events: about one in five. At 20
million orders a customer's order history touches 24 pages. The data-scale suite found the one plan that did not hold:
order history matches `customer_token = $1 OR subject = $2`, and `subject` had no index, so every order was
read. Migration 0052 adds the index; Postgres now combines both with a BitmapOr. Revisit with hash
partitioning by `id`, or Citus distribution by customer, if orders pass about 200 million rows.

**Per-module databases: documented, not built.** The modules already talk through the outbox and hold no foreign
keys into each other's tables (payments, invoices and search keep order and product ids as plain values). A module
moves to its own database when it gets its own outbox and relay, and its consumers' `processed_events` move with
it. Candidates, in order:

1. Search: a read model rebuilt from events, already served by OpenSearch and Qdrant at scale.
2. Analytics: append-only, already mirrored to ClickHouse.
3. Agent chat: `chat_sessions`, `chat_messages` and `handoffs` are referenced by nothing else.
4. Audit and LLM traces: written by every module in the caller's transaction today; they would need
   asynchronous writes through the outbox.

Orders, payments, inventory and PII go last. Checkout changes all four in one transaction today; splitting them
needs the Temporal sagas of S4 to replace those transactions, plus a decision on read-your-writes across
databases.

## Consequences

- Old months leave Postgres in seconds of catalog work instead of hours of deletes, and the append-only
  triggers stay in force for the application.
- Plans hold as data grows: the [data-scale benchmark](../benchmarks/data-scale.md) shows the same shapes and
  bounded pages touched at 1M, 10M and 100M order events. The suite runs at 1M on every push (Services
  workflow), and at 10M and 100M nightly and when partitioning changes (Data scale workflow).
- Each consumer delivery and each webhook takes one more round trip, for the lock. Lookups without a time
  bound, such as the dedupe checks, probe every partition. Archival keeps that count small.
- A default partition stops Postgres from reading partitions in order for `ORDER BY time LIMIT n`; it uses a
  Merge Append instead, which the latency budgets cover. Watch the default partitions: they should stay empty.
- Creating a partition briefly takes an exclusive lock on its parent; the job gives up after 5 s and retries.
- Migration 0051 copies each table inside one transaction and holds its lock until commit: 25 to 37 s per
  million order events on a laptop. Upgrades with large existing tables need a maintenance window.
- Idempotency keys grow too, but they are rewritten and deleted, so they need a TTL sweep, not partitions. That
  is left for later.

## Alternatives considered

- **Row-by-row retention deletes:** bloat, vacuum load, and they fight the append-only triggers.
- **pg_partman or TimescaleDB:** extensions that PGlite and several managed services do not offer.
- **A separate unpartitioned dedupe table:** keeps `ON CONFLICT`, but adds a table that grows without bound.
  That was the problem being solved.
- **Deduplicating on the event's own timestamp** (making it part of the key): brokers can redeliver an event
  with a missing or rounded timestamp, which would silently break deduplication.
- **Partitioning `orders`:** see above. The cost lands on every lookup and every foreign key, and its size does
  not need it.
- **BRIN indexes instead of partitions:** cheap time-range scans, but no cheap way to remove a month.
