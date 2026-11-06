# ADR 0002: Use embedded PGlite for the zero-dependency demo and tests

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

The README promises "try it in 60 seconds, no API keys": `pnpm install && pnpm demo` must work on a laptop without Docker, a database server or credentials. Contributors should be able to run the test suites the same way, while CI must still prove everything on real PostgreSQL. The schema relies on PostgreSQL features (`ltree`, `pg_trgm`, `pgvector`, `FOR UPDATE SKIP LOCKED`, advisory locks, generated columns), so a different database engine is not an option.

## Decision

- The data layer has two drivers behind the same `Database` interface and the same Drizzle and raw-SQL code: `postgres` (a `pg` connection pool) and `pglite` ([PGlite](https://pglite.dev), PostgreSQL compiled to WebAssembly) loaded with the `ltree`, `pg_trgm` and `pgvector` extensions.
- Both drivers run the **same migrations** from `apps/api/migrations`.
- `DATABASE_DRIVER=pglite` is allowed only with `PROFILE=lite`, and in production only together with `DEMO_MODE=true`. The config loader refuses anything else.
- Test helpers use an in-memory PGlite per test file unless `TEST_DATABASE_URL` points at a real server, in which case each file gets a freshly migrated database that is dropped afterwards. CI runs the end-to-end suites on both.

## Consequences

- The demo and most tests need nothing but Node.js.
- PGlite is a single-connection, single-threaded WebAssembly build, so latency numbers from it are not representative: the search latency benchmark only asserts its budget on real PostgreSQL, and published benchmarks always state the driver.
- Each PGlite instance uses roughly 100 MB of memory; parallel test workers are capped with `VITEST_MAX_WORKERS`.
- Every SQL feature we use must work in both. Running the end-to-end suite on both drivers in CI catches divergence early.
- PGlite tracks a specific PostgreSQL major version, which may differ from production; features that depend on a newer major (such as SQL/PGQ property graphs) must be detected at runtime with a fallback.

## Alternatives considered

- **SQLite:** a different SQL dialect with no `ltree`, `pgvector` or advisory locks.
- **Docker or Testcontainers only:** reliable, but breaks the no-install demo and slows down local tests.
- **Downloading PostgreSQL binaries at install time:** platform-specific, large, and fragile on locked-down machines.
