# Lite profile benchmark

**Status: first measured run on 2026-11-05, on a laptop with Postgres on the same machine (section 3).** The
VPS run and the 8-hour soak are still to do. Every value on this page comes from a real run, with the commit,
the hardware and the raw output recorded; anything not measured says so. Nothing here is an estimate.

The lite profile is the single-VPS tier: one Postgres, Valkey, the API, the web app and Caddy in Docker
Compose. Targets come from the development plan and are starting values, to be tuned only after the first
real benchmarks (and only through a reviewed PR).

| Benchmark | Source | Pass criteria | Where it runs |
| --- | --- | --- | --- |
| Search latency, 10,000 products | `apps/api/test/integration/search-benchmark.int.spec.ts` | p95 under 150 ms | `pnpm test:int` in CI when `TEST_DATABASE_URL` is set (`.github/workflows/ci.yml`) |
| Mixed load | `tests/load/lite.js` (k6) | read p95 under 300 ms, checkout p95 under 800 ms, errors under 0.1% | Nightly 2-minute run against the demo profile (`.github/workflows/stack.yml`); full run by hand |
| Soak | `tests/load/lite.js` with `DURATION=8h` | same thresholds for 8 hours, no memory, connection or queue growth | By hand, before a release ([soak-lite.md](soak-lite.md)); a 5-hour run weekly in CI (`.github/workflows/soak.yml`) |

## 1. Search latency at 10,000 products

What the test does:

- Creates a fresh, migrated database (`apps/api/test/support/test-db.ts` makes an `ab_test_*` database and
  drops it afterwards).
- Imports `generateCatalog({ products: 10_000 })` from `@agentbazaar/testkit` (deterministic seed), rebuilds
  the search read model with `SearchIndexer.reindexAll()` and runs `ANALYZE search_documents`.
- Warms up with 10 queries, then times 100 queries through `SearchService.search()`, the same code path the
  REST endpoint and the MCP `search_products` tool use.
- Workload mix: 26 text queries including typos (`keybaord`, `chocolat`), a SKU (`THOCK-TK87-RED`), a query
  with no hits (`xyzzy`) and one in Hindi (`डार्क चॉकलेट`, from 2026-11-08; the 2026-11-05 results below predate
  it); every fifth query is a browse with empty text; six filter combinations
  (none, in stock, category, max price, category plus min price, brand); every seventh query asks for page 2.
- Prints `p50`, `p95` and `max`, and fails when p95 is 150 ms or more.
- Runs only against real Postgres. On embedded PGlite (single-threaded WebAssembly) the suite is skipped,
  because its timings say nothing about a production database.

Rerun it:

```bash
# Any Postgres with pgvector, for example the image CI uses:
docker run -d --name ab-bench -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg18

pnpm install --frozen-lockfile
pnpm build
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  pnpm --filter @agentbazaar/api test:int search-benchmark
```

The trailing `search-benchmark` is a Vitest file filter. Copy the printed line
`search latency over 100 queries, 10k products: p50=... p95=... max=...` into the results table below.

## 2. Mixed load with k6

`tests/load/lite.js` drives two constant-arrival scenarios against the API:

| Scenario | Rate | Virtual users | What it does |
| --- | --- | --- | --- |
| `browse` | 28 requests/s | 60 pre-allocated, up to 100 | 50% search (9 queries, one with a typo), 30% product page, 15% availability for six hero SKUs, 5% category tree |
| `checkout` | 2 iterations/s | 20 pre-allocated, up to 60 | create cart, add one SKU picked at random from those `setup()` found, start a checkout session with an `Idempotency-Key`, complete it as cash on delivery with a synthetic address |

`setup()` runs once before the scenarios. It pages through the in-stock catalog (`/api/v1/products?inStockOnly=true`),
skips premium and customizable products, and keeps up to 40 SKUs whose availability shows the display cap of 50
units, starting with `KOKOA-MINI-13G`. It fails the run if it finds none.

Thresholds (k6 exits non-zero when one fails): `http_req_failed` rate under 0.1%, `read_latency` p95 under
300 ms, `checkout_latency` p95 under 800 ms. `checkout_latency` covers session start to order creation.
`DURATION` defaults to `3m` and `BASE_URL` to `http://localhost:4000`. Together the scenarios produce the
plan's lite profile: about 30 mixed requests per second with a checkout peak of 2 orders per second.

### Boot a target

Quick run on a laptop (demo profile: embedded PGlite, mock payments, no keys):

```bash
docker compose -f deploy/compose/docker-compose.yml --profile demo up -d --build
until curl -fs http://localhost:4000/readyz; do sleep 5; done
k6 run -e BASE_URL=http://localhost:4000 tests/load/lite.js
docker compose -f deploy/compose/docker-compose.yml --profile demo down -v
```

Numbers from the demo profile are **not** the lite benchmark: PGlite is an in-process WebAssembly
Postgres meant for demos and tests. Label them "demo (PGlite)" if you share them at all.

Published lite benchmark (real Postgres):

1. Provision a VPS and record its size in the environment table below.
2. Follow the production lite setup in the README (`cp .env.example .env`, generate keys with
   `pnpm --filter @agentbazaar/api cli keys`, then
   `docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite up -d --build`),
   then seed the catalog with `pnpm db:seed` as described in the README installation section. The k6
   script needs the hero products (`thock-tk87-mechanical-keyboard`, `KOKOA-MINI-13G` and the other SKUs
   listed at the top of `tests/load/lite.js`).
3. Run k6 from a separate machine in the same region, so the load generator does not compete with the
   store for CPU. Note whether traffic went through Caddy or straight to the API port.
4. Keep the raw summary:

```bash
mkdir -p tests/load/results   # git-ignored
k6 run -e BASE_URL=https://api.shop.example.com \
  --summary-export=tests/load/results/lite-$(git rev-parse --short HEAD).json tests/load/lite.js
```

Soak: `k6 run -e BASE_URL=... -e DURATION=8h tests/load/lite.js`, while watching API memory,
Postgres connections and the outbox backlog (`agentbazaar_outbox_pending` on `/metrics`, and `/readyz`).

**Stock caveat for long runs.** Checkouts spread over up to 40 SKUs with at least 50 units each. Each SKU sells
about 3 units a minute, so runs of up to about 10 minutes are safe. An 8-hour soak places about 57,600 orders
(roughly 1,440 per SKU), more than the seeded catalog holds. On a load-test database (never a real store), raise
stock before a soak:

```sql
UPDATE stock_levels SET on_hand = on_hand + 2000;
```

### Nightly CI run

The `demo` job in `.github/workflows/stack.yml` (on push to `main`, nightly at 03:00 UTC and on manual
dispatch) boots the Docker demo profile, smoke-tests search, the Agent Card and MCP `tools/list`, then runs
`tests/load/lite.js` for 2 minutes with `grafana/run-k6-action`. A failed threshold fails the job. It is a
regression alarm on PGlite, not the published benchmark.

## 3. Results

### 2026-11-05: laptop, local Postgres

A development-machine baseline, not the VPS benchmark of section 2: k6, the API and Postgres shared one laptop
(so they competed for CPU), requests went straight to the API port without Caddy, and the API ran with
`NODE_ENV=development` and ephemeral keys. All three k6 thresholds passed.

How it was run:

1. A fresh `agentbazaar_load` database on the local Postgres, migrated and seeded with
   `pnpm --filter @agentbazaar/api cli seed --products 1000` (1,000 products, 1,773 variants).
2. `pnpm build`, then `node apps/api/dist/main.js` with `DATABASE_URL` pointing at that database,
   `NODE_ENV=development`, `LOG_LEVEL=warn` and `RATE_LIMIT_PER_MINUTE=100000`.
3. `k6 run -e BASE_URL=http://localhost:4000 -e DURATION=2m tests/load/lite.js` with k6 v1.8.2 (the official
   Windows release, SHA-256 checked against the release's checksum file). Raw summary and console output:
   `tests/load/results/lite-2026-11-05-laptop.json` and `.log` (git-ignored; attach them to the PR).
4. Search: the `search-benchmark` command from section 1, run on its own against the same Postgres server.

Search, 10,000 products, 100 timed queries (real Postgres):

| Metric | Value | Target |
| --- | --- | --- |
| p50 | <!-- METRIC:search_p50_ms_10k -->11.6<!-- /METRIC --> ms | none |
| p95 | <!-- METRIC:search_p95_ms_10k -->23.0<!-- /METRIC --> ms | under 150 ms |
| max | <!-- METRIC:search_max_ms_10k -->35.7<!-- /METRIC --> ms | none |

A second run printed p50=11.1 ms, p95=23.3 ms, max=33.8 ms.

k6 mixed load, 2 minutes (real Postgres, 1,000 products):

| Metric | Value | Target |
| --- | --- | --- |
| Read p50, p99, max | 7.0 ms, 21.8 ms, 100 ms | none |
| Read p95 | <!-- METRIC:k6_read_p95_ms -->17.3<!-- /METRIC --> ms | under 300 ms |
| Checkout p50, p99, max | 13 ms, 51.4 ms, 82 ms | none |
| Checkout p95 | <!-- METRIC:k6_checkout_p95_ms -->35<!-- /METRIC --> ms | under 800 ms |
| Error rate | <!-- METRIC:k6_error_rate -->0.00% (0 of 4,379 requests)<!-- /METRIC --> | under 0.1% |
| Achieved request rate | <!-- METRIC:k6_achieved_rps -->36.4<!-- /METRIC --> req/s overall: 36.0 from the scenarios (30.0 iterations/s, a checkout iteration is 4 requests) plus 59 setup requests | about 30 |
| 8-hour soak | <!-- METRIC:k6_soak_8h_result -->not run yet<!-- /METRIC --> | pass, with no memory, connection or queue growth |

Also from that run: 4,081 of 4,081 checks passed; 240 orders were placed, all `cod_confirmed`, over 40 SKUs
(at most 10 per SKU), and no stock row ended with `reserved > on_hand`. The API process used 231 MB (Windows
working set) idle before the run and 177 MB right after it; two minutes say nothing about growth over a soak.

Concurrency, `apps/api/test/integration/concurrency.int.spec.ts` on the same Postgres: 1,000 parallel checkouts
for 10 units created exactly 10 sessions (201) and refused 990 with `409 out_of_stock`; reserved stock never
exceeded stock on hand; the 10 winners paid and the variant ended at 0 on hand, 0 reserved. The test took 7.1 s.

Environment:

| Item | Value |
| --- | --- |
| Date | 2026-11-05 |
| Host | Laptop, Windows 11 Enterprise (Insider Preview, build 26340) |
| Host CPU | <!-- METRIC:host_cpu -->Intel Core i5-1345U, 10 cores, 12 threads<!-- /METRIC --> |
| Host RAM | <!-- METRIC:host_ram -->16 GB<!-- /METRIC --> |
| Postgres version | <!-- METRIC:postgres_version -->PostgreSQL 18.0 with pgvector 0.8.1, on the same host (shared_buffers 256 MB, max_connections 400)<!-- /METRIC --> |
| Node.js version | <!-- METRIC:node_version -->v26.12.1<!-- /METRIC --> |
| Commit | <!-- METRIC:commit_sha -->uncommitted working tree on top of `a786c9d`<!-- /METRIC --> |
| k6 | v1.8.2, on the same host as the API |
| Through Caddy | No, straight to the API on port 4000 |

For every run, record the k6 version, where the load generator ran, and whether requests went through Caddy.

## 4. Rules for publishing numbers

- No number without its commit SHA, hardware, Postgres and Node.js versions, and the raw k6 summary (JSON)
  attached to the release or the PR that changes this page.
- PGlite and demo-profile numbers are labelled separately and never go in the lite tables.
- A failed threshold is published as a failure. Thresholds are not loosened to make a run pass; changing
  one needs a PR that explains why.
- Re-measure at every release tag and keep earlier results, so regressions are visible.
- Never use real customer data. The catalog comes from the deterministic generator in `@agentbazaar/testkit`
  and checkout uses synthetic `@example.com` addresses.

## Growth and scale (pending)

Search on the growth and scale engines (golden-set recall against lite, p95 at 100,000 products) has its own
page: [search.md](search.md). The growth and scale load benchmarks below are not run yet. They need real
multi-node infrastructure, and cloud spend for load tests is a human approval step.

| Profile | Concurrent sessions | Mixed requests per second | Checkout peak | Pass criteria |
| --- | --- | --- | --- | --- |
| Lite | 100 | 30 | 2 orders per second | Read p95 under 300 ms, checkout p95 under 800 ms, errors under 0.1% |
| Growth | 2,000 | 400 | 20 orders per second | Same latency, errors under 0.1%, no data loss on replica failover |
| Scale | 5,000 plus 500 agent sessions | 1,500 | 50 orders per second flash-sale spike | Same latency, errors under 0.1%, autoscaling recovers within 5 minutes, zone-failure drill passes |

Soak length: 8 hours for lite, 24 hours for scale.
