# syntax=docker/dockerfile:1.7
# PostgreSQL 18 with pgvector 0.8.7 and Apache AGE 1.8.0 (openCypher graph queries): the database image for every
# Postgres AgentBazaar runs itself (Compose, CI, the test stacks). Build:  docker build -t agentbazaar-postgres deploy/postgres
# AGE's official PG18 image is postgres:18 on Debian trixie, as is the pgvector image, so its three files are copied.
# AGE is deliberately not preloaded: with its hooks in every backend, TRUNCATE fails in any database that lacks the
# extension. The app runs LOAD 'age' in the transactions that use it.
FROM apache/age:release_PG18_1.8.0@sha256:47a0b054c3663a3e64a25fc0c5a982f1b58348019274b326a691cdf77f78eb58 AS age

FROM pgvector/pgvector:0.8.7-pg18-trixie@sha256:ab49524d18df7200b74ac9a475e1db6297fc1eb57da4c214c63d10ecc4b754fa
COPY --from=age /usr/lib/postgresql/18/lib/age.so /usr/lib/postgresql/18/lib/
COPY --from=age /usr/share/postgresql/18/extension/age.control /usr/share/postgresql/18/extension/age--1.8.0.sql \
  /usr/share/postgresql/18/extension/
