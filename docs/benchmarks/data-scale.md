# Data scale: query plans at 1M, 10M and 100M order events

Milestone S3's definition of done is "query plans stay stable at 100 million order events". The
[data-scale suite](../../apps/api/test/services/data-scale.spec.ts) loads synthetic data into the real, partitioned
schema ([ADR 0013](../adr/0013-time-partitioned-event-logs.md)) and checks every hot query four ways. It must hold
at every scale:

- **Plan shape**: the set of tables and indexes the plan touches. Hot paths must use indexes only, with the same
  shape at every scale. A sequential scan of an empty partition (future months, the default) is ignored.
- **Partition pruning**: an upper bound on the partitions scanned.
- **Pages touched** (`EXPLAIN (ANALYZE, BUFFERS)`): the cost of the plan whatever the disk or cache. It may only grow
  as B-trees deepen.
- **Latency**: p95 of 40 runs with random parameters, after 3 warm-up runs.

Result: **all nine probes pass at 1M, 10M and 100M order events with identical plan shapes.** Run
[42211447035](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42211447035), commit `8afc8da`,
2026-11-06.

## Setup

| | |
| --- | --- |
| Runner | GitHub `ubuntu-latest`: 4 vCPU (AMD EPYC 7763 for 10M and 100M, Xeon Platinum 8370C for 1M), 16 GB RAM, 145 GB disk |
| Postgres | `pgvector/pgvector:pg18` with `shared_buffers=4GB`, `maintenance_work_mem=2GB`, `work_mem=64MB`, `fsync=off`; planner settings at their defaults |
| Workflow | [`data-scale.yml`](../../.github/workflows/data-scale.yml): when the partitioning or the suite changes, and nightly. The Services workflow runs the suite at 1M on every push (33 s there) |

The dataset is generated with `generate_series`. Load first, then keys and indexes, then `VACUUM (ANALYZE)`:

- Orders are spread over 24 months, with five status events each (`pending_payment` to `delivered`). Customers
  have about four orders each, across the whole period.
- Payments: one for each of the first 1M orders.
- The outbox and its consumer markers hold the last 60 days only (older months are archived), capped at 1M rows,
  with 1,000 events still pending.
- Webhook deliveries and analytics events: N/10, capped at 2M, over 24 months.
- Every event log has a partition for each of the 24 months, three months ahead and a default.

## Sizes and load times

| Order events | Orders | Load | Keys and indexes | VACUUM ANALYZE | Database |
| --- | --- | --- | --- | --- | --- |
| 1,000,000 | 200,000 | 4 s | 4 s | 4 s | 386 MB |
| 10,000,000 | 2,000,000 | 37 s | 41 s | 13 s | 3.4 GB |
| 100,000,000 | 20,000,000 | 268 s | 580 s | 35 s | 26.6 GB |

At 100M: `order_events` 14.1 GB (heap, `(id, created_at)` key and `(order_id)` index, over 29 partitions),
`orders` 11.1 GB, `webhook_events` 415 MB, `analytics_events` 309 MB, `payments` 294 MB, `outbox_events` 240 MB,
`processed_events` 126 MB.

## Results

Pages touched / p50 / p95 in milliseconds, and partitions scanned. Budgets are the suite's limits.

| Query | 1M | 10M | 100M | Partitions scanned | Budget (pages, p95) |
| --- | --- | --- | --- | --- | --- |
| Customer order history: orders | 26 / 0.7 / 1.0 | 25 / 0.7 / 1.0 | 24 / 2.5 / 3.1 | not partitioned | 100, 100 ms |
| Customer order history: events | 198 / 1.7 / 1.9 | 300 / 2.0 / 2.3 | 268 / 6.4 / 14.2 | 27, 27, 24 | 800, 100 ms |
| Events for one recent order | 11 / 1.1 / 1.3 | 12 / 1.1 / 1.3 | 13 / 1.5 / 1.8 | 6 | 100, 50 ms |
| Recent events by type (admin feed) | 4 / 1.1 / 1.4 | 18 / 1.1 / 1.3 | 16 / 1.1 / 1.2 | 5 (24 pruned) | 200, 50 ms |
| Outbox relay claim (batch of 100) | 1,559 / 4.5 / 5.6 | 1,760 / 4.2 / 5.3 | 1,760 / 4.1 / 5.2 | all 30 | 3,000, 100 ms |
| Analytics aggregate: GEO, 30 days | 56 / 1.2 / 1.3 | 516 / 3.2 / 3.4 | 1,027 / 5.5 / 5.8 | 6 (23 pruned) | 2,000 ms |
| Analytics aggregate: search totals, 30 days | 19 / 1.1 / 1.3 | 102 / 3.5 / 3.7 | 195 / 6.1 / 8.9 | 6 (23 pruned) | 2,000 ms |
| Archive: partition selection | 1,451 / 1.8 / 1.9 | 518 / 2.0 / 3.4 | 518 / 1.9 / 3.3 | catalog | 200 ms |
| Archive: export batch (1,024 blocks) | 416 / 80 / 102 | 1,024 / 181 / 196 | 1,024 / 173 / 187 | 1 | 1,100 pages, 2,000 ms |

Reading the table:

- **Hot paths are flat.** Order history, an order's events, the admin feed and the relay claim touch the same
  pages at 1M and 100M, within one more B-tree level. Customer history reads one index entry per order in every
  month since the customer's first order, so it scales with months of history, not rows. Archival bounds that.
- **The 30-day aggregates** read the rows in their window. These grow with the synthetic analytics volume (1M:
  4K rows in the window, 100M: 82K). Their plans stay pruned to the window's partitions at every scale.
- **The relay claim scans every outbox partition.** It has no time bound, but each probe is a partial index on
  unpublished rows, and archiving the outbox monthly keeps the partition count small.

### Plans at 100M

Customer order history, orders: both indexes combined, then the payment link per order.

```text
Limit (actual time=2.339..3.942 rows=4.00 loops=1)
  ->  Result
        ->  Sort  (Sort Key: o.created_at DESC, o.id)
              ->  Bitmap Heap Scan on orders o (rows=4.00)
                    Recheck Cond: ((customer_token = '...') OR (subject = 'customer:...'))
                    ->  BitmapOr
                          ->  Bitmap Index Scan on orders_customer_idx (rows=4.00)
                          ->  Bitmap Index Scan on orders_subject_idx (rows=4.00)
        SubPlan 1
          ->  Limit -> Sort -> Index Scan using payments_order_idx on payments p (loops=4)
Execution Time: 3.964 ms
```

Customer order history, events: months before the customer's first order are never executed (run-time pruning
from the `min(created_at)` bound).

```text
Sort (Sort Key: order_events.id) (rows=20.00)
  InitPlan 1
    ->  Aggregate -> Index Scan using orders_pkey on orders (rows=4.00)
  ->  Append (rows=20.00)
        ->  Bitmap Heap Scan on order_events_p202411 (never executed)
        ->  Bitmap Heap Scan on order_events_p202412 (rows=5.00)
              ->  Bitmap Index Scan on order_events_p202412_order_id_idx
        ->  Bitmap Heap Scan on order_events_p202501 (rows=0.00)
        ...   one index probe per later month, plus the three months ahead and the default
```

Admin feed: 24 old months pruned at executor start, newest rows first through the `(kind, at DESC)` index.

```text
Limit (rows=50.00)
  ->  Merge Append (Sort Key: analytics_events.at DESC)
        Subplans Removed: 24
        ->  Index Scan using analytics_events_p202611_kind_at_idx on analytics_events_p202611 (rows=50.00)
        ->  Index Scan using analytics_events_p202612_kind_at_idx on analytics_events_p202612 (rows=0.00)
        ...   two more months ahead and the default, all empty
Execution Time: 0.244 ms
```

## What the suite found

Its first run, at only 1M events (200,000 orders), showed order history reading the whole `orders` table: p95
122 ms. `listForCustomer` matches `customer_token = $1 OR subject = $2`, and `subject` had no index, so the OR
could not use an index. At 20M orders that is seconds per page view. Migration 0052 adds
`orders_subject_idx (subject, created_at DESC)`; the plan became the BitmapOr above.

## Converting an existing database

Migration 0051 copies each event log into its partitioned replacement inside the migration's transaction, so the
tables are locked until it commits. These timings come from a laptop (native Postgres 18.0 on Windows,
`shared_buffers=256MB`, `fsync=off`): migrations 0050 to 0052 on a database already holding the data.

| Order events (plus 1/5 orders and side tables) | 0050 to 0052 |
| --- | --- |
| 1,000,000 | 37 s |
| 5,000,000 | 120 s |

That is about 25 to 37 s per million order events. A lite install has far fewer; a large one should upgrade in a
maintenance window.

## Run it yourself

```bash
# 1M against the shared test Postgres (tests/infra/services.env), as CI does
pnpm --filter @agentbazaar/api exec vitest run --project services test/services/data-scale.spec.ts

# 10M against your own Postgres 18 with pgvector, writing the JSON report
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres DATA_SCALE_EVENTS=10000000 \
  DATA_SCALE_REPORT=data-scale-10M.json pnpm --filter @agentbazaar/api exec vitest run --project services test/services/data-scale.spec.ts
```

Each scale needs roughly 0.27 GB of disk per million order events, plus WAL and sort space while indexes build.
`DATA_SCALE_PARALLEL` (default 4) sets the number of loading connections, and `DATA_SCALE_EVENTS_PER_ORDER`
(default 5) the events per order. The test database is dropped at the end.
