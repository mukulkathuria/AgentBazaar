# ADR 0003: Use a transactional outbox with an in-process bus in lite instead of BullMQ

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

The product plan listed Valkey with BullMQ for queues and jobs in the lite profile, NATS JetStream in growth and Kafka with an outbox relay in scale. The system needs two things: reliable delivery of domain events (to keep the search index, analytics and storefront revalidation in step with the database) and periodic jobs (expiring quotes, negotiations, reservations and checkout sessions; retention deletion).

Publishing to a queue after a database commit is a dual write: a crash between the two loses or duplicates events. BullMQ would also make Valkey a hard dependency for correctness, which conflicts with the zero-dependency demo ([ADR 0002](0002-pglite-demo-and-tests.md)).

## Decision

- Every state change that others care about appends a row to `outbox_events` **in the same transaction** (`appendEvent`), so the event exists if and only if the change committed.
- An `OutboxRelay` reads pending events and hands them to an `EventBus` port, retrying failed deliveries with backoff:
  - **lite:** `InProcessEventBus` runs subscribed consumers in the API process;
  - **growth:** NATS JetStream, publishing with a message ID for broker-side deduplication and durable pull consumers that acknowledge after their transaction commits;
  - **scale:** Apache Kafka.
- Consumers are idempotent: each claims `(consumer, event_id)` in `processed_events` inside its own transaction, so a redelivered event changes nothing.
- Periodic jobs run in a `Scheduler` that takes a transaction-scoped advisory lock per job (`pg_try_advisory_xact_lock`), so with several API instances only one runs a given job at a time.
- Valkey stays in the lite stack for caching, rate limits and per-agent quotas, but nothing correctness-critical depends on it; without `VALKEY_URL` an in-memory cache is used.

## Consequences

- No lost or phantom events, and the demo needs only PostgreSQL.
- One data model for every profile: moving up a tier means pointing new consumers at the outbox and backfilling with `cli reindex`, not changing the schema.
- In lite, consumers share the API's CPU; heavy consumers will move to growth's NATS-backed workers when measurements show the need.
- Delivery is at least once, so every consumer must stay idempotent; this is covered by tests that replay events.
- The outbox table grows and needs pruning of published events.
- This deviates from the plan's BullMQ choice for lite; this ADR records why.

## Alternatives considered

- **BullMQ on Valkey:** mature, but adds a dual write and a hard Valkey dependency.
- **pg-boss or another Postgres-backed queue:** a reasonable choice, but another dependency for what the outbox plus a small scheduler already provide.
- **`LISTEN`/`NOTIFY` alone:** notifications are lost when no listener is connected, so it cannot be the source of truth.
