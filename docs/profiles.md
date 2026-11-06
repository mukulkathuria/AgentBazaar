# Choosing and changing a profile

All three tiers are compiled, tested and shipped. The `PROFILE` setting (`lite`, `growth` or `scale`) chooses which adapters and services run; nothing is commented out, and one data model serves every profile. Moving up a tier is a configuration change plus a backfill, never a schema change.

The rule is **measure before scaling**: move up when metrics show a bottleneck, not in advance.

## Which profile?

| | Lite | Growth | Scale |
| --- | --- | --- | --- |
| Registered users (rough guide) | about 10 to 1,000 | about 10,000 to 1 lakh | about 10 lakh |
| Runs on | Docker Compose on one VPS | k3s or Kubernetes, 3+ nodes | Multi-AZ Kubernetes with autoscaling |
| Search | PostgreSQL full-text + trigram + pgvector | Meilisearch | OpenSearch + Qdrant |
| Events | Outbox + in-process bus | NATS JetStream | Apache Kafka |
| Cache, rate limits, agent quotas | Valkey (or in-memory) | Valkey | Valkey |
| Key wrapping for personal data | Master key in the environment | OpenBao Transit | OpenBao Transit |
| Identity | Built-in issuer | Built-in or Keycloak (OIDC) | OIDC |
| Database | One PostgreSQL | Read replicas, PgBouncer | Partitioning, per-module databases |
| Ops skills needed | Docker, DNS, backups | Kubernetes, Helm, a few stateful services | A platform team |

Signals that it is time to move up: search p95 above its budget at your catalog size; PostgreSQL CPU or connections saturated by reads; a growing outbox backlog (`agentbazaar_outbox_pending`, `/readyz`); a need for more than one API instance with zero-downtime deploys; or compliance requirements for a managed secrets service.

## What the loader enforces

The profile loader ([`packages/config`](../packages/config/src/index.ts)) picks these defaults, which any explicit variable overrides:

| Profile | `SEARCH_ADAPTER` | `EVENT_BUS` | `CACHE_ADAPTER` | `SECRETS_ADAPTER` |
| --- | --- | --- | --- | --- |
| lite | `postgres` | `inprocess` | `memory` (`valkey` when `VALKEY_URL` is set) | `env` |
| growth | `meilisearch` | `nats` | `valkey` | `openbao` |
| scale | `opensearch` | `kafka` | `valkey` | `openbao` |

It then refuses to start, listing every problem, when a selected adapter lacks its settings:

| Adapter | Needs |
| --- | --- |
| `meilisearch` | `MEILISEARCH_URL` (and usually `MEILISEARCH_API_KEY`) |
| `opensearch` | `OPENSEARCH_URL`, `QDRANT_URL` |
| `nats` | `NATS_URL` |
| `kafka` | `KAFKA_BROKERS` |
| `valkey` | `VALKEY_URL` |
| `openbao` | `OPENBAO_ADDR`, `OPENBAO_TOKEN` (transit key name in `OPENBAO_TRANSIT_KEY`, default `agentbazaar-pii`) |
| `IDENTITY_PROVIDER=oidc` | `OIDC_ISSUER_URL` |

Other rules: growth and scale need a real PostgreSQL (`DATABASE_DRIVER=postgres`), and a payment adapter that serves one payer at a time (YouPI-PG) stops growth and scale from starting unless `PAYMENT_ALLOW_SINGLE_SLOT=true`.

## Running each profile

**Lite**, one VPS:

```bash
docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite up -d --build
```

**Growth services with Compose** (for evaluation; production growth runs on Kubernetes): add `--profile growth` to start Meilisearch, NATS JetStream, OpenBao and Keycloak alongside the lite services. The Compose OpenBao runs in dev mode and is not for production.

**Growth or scale on Kubernetes** with the Helm chart in [`deploy/helm/agentbazaar`](../deploy/helm/agentbazaar). Secrets come from an existing Kubernetes Secret (`agentbazaar-secrets` by default) and migrations run as a pre-install and pre-upgrade Job:

```bash
helm upgrade --install agentbazaar deploy/helm/agentbazaar -n agentbazaar \
  -f deploy/helm/agentbazaar/values-growth.yaml -f tf-values.yaml
```

On AWS, the OpenTofu/Terraform root modules in [`deploy/terraform`](../deploy/terraform) produce `tf-values.yaml` (`terraform -chdir=deploy/terraform/profiles/<profile> output -raw helm_values`). Meilisearch, NATS and OpenBao run from their own charts in the same namespace.

## Upgrading from lite to growth

1. **Back up** the database and test the restore ([runbook](runbooks/backup-restore.md)).
2. **Provision** PostgreSQL (with the `vector`, `ltree` and `pg_trgm` extensions), Valkey, Meilisearch, NATS JetStream and, if you will use it, OpenBao with a transit key created with `derived=true` (each wrap uses the customer as context).
3. **Decide on key wrapping before switching.** Existing customers' data keys are wrapped by `PII_MASTER_KEY`. The OpenBao wrapper cannot unwrap them, and re-wrapping existing keys is not automated yet. On a store that already holds customer data, keep `SECRETS_ADAPTER=env` (overriding the growth default) until a re-wrap step exists; a new growth store can start on OpenBao directly. See the [key rotation runbook](runbooks/key-rotation.md).
4. **Configure** `PROFILE=growth`, `MEILISEARCH_URL`, `MEILISEARCH_API_KEY`, `NATS_URL`, `VALKEY_URL`, and `OPENBAO_*` or the `SECRETS_ADAPTER=env` override. Deploy with `values-growth.yaml`.
5. **Backfill the new search engine** from the catalog:

   ```bash
   pnpm --filter @agentbazaar/api cli reindex
   ```

   It writes the catalog in pages of 500 products and prints progress after each page. Meilisearch applies the
   pages as background tasks, so the last products become searchable shortly after the command returns. New
   changes keep flowing through the outbox, so the index stays current after the backfill.
6. **Verify:** `/readyz` reports a draining outbox; the golden search queries score at least what they did on lite ([search benchmark](benchmarks/search.md)); place a test order end to end.
7. **Roll back** by setting `SEARCH_ADAPTER=postgres` and `EVENT_BUS=inprocess`, redeploying, and running `cli reindex` again: the PostgreSQL search read model is not updated while another engine is active.

## Upgrading from growth to scale

The same pattern: provision Kafka, OpenSearch and Qdrant, set `PROFILE=scale` with `KAFKA_BROKERS`, `OPENSEARCH_URL` and `QDRANT_URL`, deploy with `values-scale.yaml`, then run `cli reindex` to backfill OpenSearch and Qdrant. Partitioning of orders and events, per-module databases and Temporal sagas for checkout and payment are scale milestones on the road to v1.0 (see the [roadmap](../README.md#roadmap)); check the changelog for what has shipped.

## PostgreSQL versions

The Compose stack and CI use `pgvector/pgvector:pg18`. PostgreSQL 19, whose GA release is planned for 19 November 2026, adds SQL/PGQ property graphs; the product graph uses them when available and falls back to plain joins otherwise, so the same code runs on 18 and 19. Managed database services usually offer a new major version some time after its release, so check what yours provides.
