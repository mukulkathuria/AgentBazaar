# Architecture decision records

An ADR records one significant decision: the context, what we chose, what it costs us and what we turned down. ADRs are never rewritten after they are accepted; a later decision supersedes an earlier one and both link to each other. The process is described in [CONTRIBUTING.md](../../CONTRIBUTING.md#architecture-decision-records).

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-modular-monolith.md) | One NestJS-on-Fastify modular monolith with enforced module boundaries | Accepted |
| [0002](0002-pglite-demo-and-tests.md) | Embedded PGlite for the zero-dependency demo and tests, real PostgreSQL in production | Accepted |
| [0003](0003-outbox-and-event-bus.md) | Transactional outbox with an in-process bus in lite instead of BullMQ; NATS in growth, Kafka in scale | Accepted |
| [0004](0004-guarded-floor-and-concessions.md) | Guarded price floor, Boulware concession ladder, trade instead of give | Accepted |
| [0005](0005-llm-writes-words-only.md) | The LLM only writes the words: number guard and an escalate-only router | Accepted |
| [0006](0006-typescript-6.md) | Stay on TypeScript 6 while TypeScript 7's native compiler breaks typed linting | Accepted |
| [0007](0007-builtin-identity-and-oidc.md) | Built-in EdDSA identity in lite, Keycloak or any OIDC issuer from growth | Accepted |
| [0008](0008-prometheus-io-client.md) | `@prometheus-io/client` instead of the deprecated `prom-client` name | Accepted |
| [0009](0009-replica-routing-and-read-your-writes.md) | Route chosen reads to streaming replicas, with read-your-writes by WAL position | Accepted |
| [0010](0010-checkout-sagas-on-temporal.md) | Run checkout and payment as a Temporal saga in scale, behind a workflow engine port | Accepted |
| 0011 | Not used | n/a |
| [0012](0012-semantic-cache-and-observer-gating.md) | Reuse model wording only as number-free templates, and observe only turns with a risk signal | Accepted |
| [0013](0013-time-partitioned-event-logs.md) | Partition the event logs by month, archive whole months, and keep orders in one table | Accepted |
| [0014](0014-platform-at-scale-analytics-edge-siem.md) | Platform at scale: ClickHouse analytics from the outbox, a layered edge, Wazuh as a separate service | Accepted |
| [0015](0015-growth-platform-on-kubernetes.md) | Growth platform on Kubernetes: APISIX in standalone mode, an agent pool, conftest policies, opt-in tracing | Accepted |

## Template

Copy this into `docs/adr/NNNN-short-title.md`, using the next number after the highest in the table (0016); 0011 stays unused.

```markdown
# ADR NNNN: Short title in the imperative

- Status: Proposed | Accepted | Superseded by ADR NNNN
- Date: YYYY-MM-DD
- Deciders: names or handles

## Context

What problem are we solving? What constraints, forces and facts matter? Link the plan, issues and code.

## Decision

What we will do, stated plainly enough that a reviewer can check the code against it.

## Consequences

What gets easier, what gets harder, what we must now test or monitor, and when to revisit.

## Alternatives considered

Each option we turned down, and why.
```
