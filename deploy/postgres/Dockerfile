# syntax=docker/dockerfile:1.7
# PostgreSQL 18 with pgvector 0.8.7 and Apache AGE 1.8.0 (openCypher graph queries): the database image for every
# Postgres AgentBazaar runs itself (Compose, CI, the test stacks). Build:  docker build -t agentbazaar-postgres deploy/postgres
# AGE's official PG18 image is postgres:18 on Debian trixie, as is the pgvector image, so its three files are copied.
FROM apache/age:release_PG18_1.8.0@sha256:47a0b054c3663a3e64a25fc0c5a982f1b58348019274b326a691cdf77f78eb58 AS age

FROM pgvector/pgvector:0.8.7-pg18-trixie@sha256:ab49524d18df7200b74ac9a475e1db6297fc1eb57da4c214c63d10ecc4b754fa
COPY --from=age /usr/lib/postgresql/18/lib/age.so /usr/lib/postgresql/18/lib/
COPY --from=age /usr/share/postgresql/18/extension/age.control /usr/share/postgresql/18/extension/age--1.8.0.sql \
  /usr/share/postgresql/18/extension/
# AGE is loaded in every backend, so the app never runs LOAD or SET search_path: session state that PgBouncer's
# transaction pooling would not keep. New clusters get this from the sample config at initdb.
RUN echo "shared_preload_libraries = 'age'" >> /usr/share/postgresql/postgresql.conf.sample
