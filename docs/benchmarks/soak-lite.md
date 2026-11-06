# Lite profile soak

**Status: an 8-hour run is in progress (started 2026-11-06 10:53 UTC). The table below holds interim
numbers; the final row is filled in from the run's own CSV and k6 summary when it ends (section 4).**
Every number on this page comes from a real run, with the commit, hardware and raw output recorded.

The plan's release gate for each profile includes a soak: the lite load profile for 8 hours, watching memory,
connection and queue growth. Pass criteria: read p95 under 300 ms, checkout p95 under 800 ms, errors under
0.1%, and no unbounded growth of memory, database connections or the outbox backlog after warm-up.

## 1. How it runs

| Piece | What | Where |
| --- | --- | --- |
| Load | `tests/load/lite.js` (k6) with `DURATION=8h`: `browse` at 28 requests/s and `checkout` at 2 orders/s (4 requests each), about 36 requests/s and 100+ virtual users | `docs/benchmarks/lite.md` section 2 describes the scenarios |
| Sampler | `tests/load/soak-monitor.mjs`, one CSV row a minute | API `/metrics` and `/readyz`, plus `pg_stat_activity`, `processed_events` and `orders` |
| Gate | `node tests/load/soak-monitor.mjs --check <csv>` after the run | Fails on growth after a 30-minute warm-up (below) |
| CI | `.github/workflows/soak.yml`, weekly (Saturday 20:00 UTC) and on manual dispatch | 5 hours on a GitHub-hosted runner, which stops jobs at 6 hours |

The sampler records, every minute: API resident memory, V8 heap used and total, external memory, event-loop
lag p99 and active handles (all from the API's own `/metrics`); readiness and the outbox backlog and its
oldest age (`/readyz`); Postgres connections to the soak database (`pg_stat_activity`, excluding the
sampler's own); `processed_events` and `orders` row counts; and the minute's request count, 4xx and 5xx
answers, and read and checkout p95. The per-minute percentiles are interpolated from the API's latency
histogram buckets the way Prometheus `histogram_quantile` does, so they are server-side and coarse (bucket
edges at 50, 100, 150, 300, 500 and 800 ms); k6's end-of-run summary gives the client-side percentiles the
thresholds use.

Growth rules of `--check` (median of the last third of the samples after warm-up against the first third):

| Signal | Passes when |
| --- | --- |
| Resident memory | last third at most 25% (+16 MB) above the first |
| Heap used | last third at most 25% (+8 MB) above the first |
| Postgres connections | last third at most 2 above the first |
| Outbox backlog | last third at most 20 events above the first |
| Readiness | every sample ready |
| Active handles | reported only: they are mostly k6's keep-alive sockets and follow its virtual-user count |

A leak of even 1 MB a minute adds 450 MB over the 7.5 hours after warm-up and fails the memory rule; the 25%
allowance absorbs V8's heap sizing and garbage-collection timing. `processed_events` and `orders` grow
with every order by design (one row per consumer per event, and one per order) and are recorded, not gated.

### Run it yourself

```bash
pnpm install --frozen-lockfile && pnpm turbo run build --filter=@agentbazaar/api...
createdb agentbazaar_soak   # any Postgres 18 with pgvector, ltree and pg_trgm
node apps/api/dist/cli/index.js keys > soak-keys.env            # throwaway keys, keep out of git
export DATABASE_URL=postgres://.../agentbazaar_soak
node --env-file=soak-keys.env apps/api/dist/cli/index.js seed --products 1000
psql "$DATABASE_URL" -c 'UPDATE stock_levels SET on_hand = on_hand + 2000'   # load-test database only
NODE_ENV=production RATE_LIMIT_PER_MINUTE=100000 LOG_LEVEL=warn node --env-file=soak-keys.env apps/api/dist/main.js &
BASE_URL=http://localhost:4000 node tests/load/soak-monitor.mjs tests/load/results/soak.csv &
k6 run -q -e BASE_URL=http://localhost:4000 -e DURATION=8h --summary-export=tests/load/results/soak.json tests/load/lite.js
node tests/load/soak-monitor.mjs --check tests/load/results/soak.csv
```

`tests/load/results/` is git-ignored: attach the CSV, the k6 summary JSON and its log to the release.

## 2. Environment of the 2026-11-06 run

| Item | Value |
| --- | --- |
| Host | Laptop, Windows 11 Enterprise (Insider Preview, build 26340), Intel Core i5-1345U (10 cores, 12 threads), 16 GB RAM |
| Database | **Native Windows** PostgreSQL 18.0 (pgvector 0.8.1), a private cluster on port 54331 with `shared_buffers = 128MB`, `max_connections = 60`, fsync on; same host as the API |
| API | Production build (`node apps/api/dist/main.js`, `NODE_ENV=production`, generated keys, `LOG_LEVEL=warn`, `RATE_LIMIT_PER_MINUTE=100000`), Node.js v26.12.1, pool of 20 connections, straight to port 4103 without Caddy |
| Catalog | 1,000 generated products (1,773 variants) from `cli seed --products 1000`; stock raised by 2,000 per variant |
| Load generator | k6 v1.8.2 (official Windows release, SHA-256 checked) on the same host |
| Commit | `045ac7b` (main at `98dbe1f` plus a testkit export); the API was built from it |
| Other load | Several other agents were building and testing on the same laptop throughout, and free memory was often under 2 GB, so the host was noisy |

## 3. Results

### First attempt (aborted after 131 healthy minutes)

The first attempt used the shared Docker Postgres (WSL). It ran healthy for 131 minutes, then the host ran
critically low on memory, WSL was stopped and Postgres went with it; the API answered not-ready from then on.
Those 131 minutes are kept for the record, not as the gate result: 256,989 requests, no 4xx, one 5xx (in the
minute the host ran out of memory, just before Postgres went away), every sample up to then ready, resident memory 116 MB at start and a median of 158 MB
in the first third against 136 MB in the last, heap used 60 MB against 51 MB, Postgres connections 7 against 5,
outbox backlog 0 against 0 (at most 16 pending at a sample). Active handles stepped from about 90 to 127 at
minute 70 to 90, when other work slowed the host (checkout p95 reached 770 ms for one minute) and k6 added
virtual users, and then stayed flat: that is why handles are reported, not gated.

### Second run: native Windows Postgres, 8 hours

<!-- SOAK-RESULTS -->
Interim, filled in when the run ends.
<!-- /SOAK-RESULTS -->

## 4. Collecting the result of the run in progress

The run's processes were started outside any terminal so they outlive the session that launched them. Their
process ids and the start time are in the run log next to the data directory (see the T3 report); the k6
summary appears when k6 exits about 8 hours after the start.

```powershell
# results (git-ignored): tests/load/results/soak-lite.csv, soak-lite.json (k6 summary), soak-lite.log
node tests/load/soak-monitor.mjs --check tests/load/results/soak-lite.csv
```
