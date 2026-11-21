# ADR 0016: Read the product graph with Apache AGE inside the same PostgreSQL

- Status: Accepted
- Date: 2026-11-21
- Deciders: Mukul Kathuria

## Context

Recommendations read `product_edges` (`compatible_with`, `bought_together`, `alternative_of`) through the
`GraphRepository` port. The plan was SQL/PGQ property graphs in PostgreSQL 19, with plain joins elsewhere, but
19.0 shipped without SQL/PGQ: its grammar has no `GRAPH_TABLE` (checked on a 19.0 server on 2026-11-21). The owner
wants graph queries on the same database, so the graph stays transactional with orders and needs no second store.

Apache AGE (Apache-2.0) adds openCypher to PostgreSQL as an extension. Its newest release, 1.8.0, supports
PostgreSQL 18; AGE for 19 exists only as a branch and a development snapshot. Managed RDS and Aurora do not offer
AGE, and PGlite (the demo and the default test database) cannot load it.

## Decision

- **One database image, PostgreSQL 18 with AGE 1.8.0 and pgvector 0.8.7** (`deploy/postgres/Dockerfile`, both
  bases pinned by digest; AGE's three files are copied from its official PG18 image). Compose, CI, the test stacks
  and the cluster test run it, and the release workflow publishes and signs it as `agentbazaar-postgres`. The
  stack goes back from 19 to 18 until AGE releases for 19. The image preloads AGE (`shared_preload_libraries`), so
  the app never runs `LOAD`.
- **`product_edges` stays the source of truth; AGE is a mirror read through the same port.** `AgeGraphRepository`
  (engine `age`) replaces the SQL/PGQ adapter; `SqlGraphRepository` (engine `sql`) stays for PGlite, RDS and Aurora.
  At startup the app uses AGE only when the server lists it and preloads it, then, in one transaction under an
  advisory lock, creates the extension and the graph `catalog` if missing and fills an empty graph from
  `product_edges`. Any failure falls back to joins; a request never fails because of the choice.
- **Writes keep both stores in one transaction.** The seed import and the `bought_together` learner call
  `GraphRepository.upsertEdges` in the transaction that wrote `product_edges` (a no-op for joins). The graph holds a
  vertex per product (a unique index on its id) and, because every relation is symmetric and AGE plans an
  undirected pattern as a scan of every edge, a directed edge each way per related pair, carrying the pair's larger
  weight, which is what the joins return. `cli graph rebuild` drops and refills the graph.
- **Queries are fixed Cypher with bound parameters.** Values travel only in the agtype map that is `cypher()`'s third
  argument. AGE resolves its operators through `search_path`, so each Cypher statement runs in a transaction that
  puts `ag_catalog` first with `set_config(..., true)`: transaction-local, which PgBouncer's transaction pooling
  keeps. The ranking SQL around both engines is shared, so they agree by construction, and an integration test
  compares every product's answers on the AGE image.
- **"Complete the setup" is the first two-hop query**: products Y bought together with an item X compatible with
  product P, excluding P and everything directly related to P. A path scores compatible(P, X) × bought_together(X, Y)
  (each the larger weight of the pair), Y's score is the sum over its paths, summed as numeric so the order rows
  arrive in cannot change it; ties break by id, and the service puts in-stock items first. It is served at
  `GET /api/v1/products/{slug}/complete-the-setup` and by the `complete_the_setup` MCP tool.

## Consequences

- Graph reads and writes share PostgreSQL's transactions, backups, replicas and access control; a rollback leaves
  both stores unchanged.
- The database is PostgreSQL 18, not 19. An install that already ran 19 (only possible from commit `12e18b5`) must
  dump and restore into the 18 image. Moving to 19 waits for an AGE release for it.
- RDS, Aurora and PGlite read with joins, with the same results; the two-hop query is a self-join there.
- The app needs a role that can read `shared_preload_libraries` (a superuser or `pg_read_all_settings`) and create
  the extension, or an administrator who creates it; otherwise it uses joins.
- The first start after an upgrade fills the graph from `product_edges` (the 675 edges of the 300-product demo
  catalog take about 0.3 s on a laptop).
  Instances still running an older version during a rolling upgrade write only `product_edges`; run
  `cli graph rebuild` once they are gone.
- Every Cypher statement costs an extra round trip for `set_config`. JIT is off in those transactions, because
  AGE's row estimates can push simple index lookups over the JIT threshold.

## Alternatives considered

- **Wait for SQL/PGQ.** It is not in 19.0, and no date is set.
- **AGE on PostgreSQL 19.** AGE for 19 is unreleased; a development snapshot is not a production dependency.
- **A separate graph database (Neo4j, Memgraph).** A second store to run, back up and keep consistent, with no
  shared transaction; the graph here is small and fixed-hop.
- **Keep only the joins.** They stay as the fallback, but the owner wants openCypher on the same database, and new
  multi-hop queries are clearer in Cypher.
- **Triggers on `product_edges` that write the graph.** They would also catch writes outside the app, but a server
  that loses AGE (a restore without the preload) would then fail every write to `product_edges`.
