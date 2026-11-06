# r/selfhosted draft

Status: DRAFT. Before posting: read the current sidebar rules (self-promotion limits, required flair for
your own project), fill or delete every metric marker, and re-check the "no telemetry" statement against
the release (search the code for outbound HTTP calls and confirm none phone home).

## Title

`AgentBazaar: a self-hosted store on one VPS where AI agents can shop and haggle (MIT, Docker Compose)`

## Body

I built an open-source store that runs on a single VPS with Docker Compose, and that AI agents can use as
well as people. It is MIT-licensed and has no hosted tier: you run it, you own the data.

What runs in the lite profile:

- Postgres (with pgvector, `ltree` and `pg_trgm`) for everything, including search
- Valkey for cache, rate limits and per-agent quotas
- The API (NestJS on Fastify) and the storefront (Next.js, server-rendered)
- Caddy in front, with automatic HTTPS and security headers; `/metrics` is not exposed publicly
- Optional: the Python AI service, and Prometheus plus Grafana via `--profile observability`

Try it first without keys or a database (Docker demo on embedded Postgres, mock payments):

    docker compose -f deploy/compose/docker-compose.yml --profile demo up --build

Then open http://localhost:3000, or connect an MCP client to http://localhost:4000/mcp.

For a real install: copy `.env.example` to `.env`, generate the signing and encryption keys with
`pnpm --filter @agentbazaar/api cli keys`, set your domains, and run
`docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite up -d --build`.
The app refuses to start in production with missing keys or an inconsistent profile, and tells you what is
missing.

Resource needs on a measured lite install: RAM <!-- METRIC:lite_idle_ram_mb -->not measured yet (the
Compose stack has not been measured)<!-- /METRIC --> idle, disk <!-- METRIC:lite_disk_mb -->not measured
yet<!-- /METRIC --> with the demo catalog. Load results and the method to rerun them are in
`docs/benchmarks/lite.md`.

No telemetry: nothing is sent to the project. Storefront analytics (AI crawler hits, AI referrals, zero-result
searches) are stored in your own Postgres, and OpenTelemetry export happens only if you set an endpoint.

Things self-hosters usually ask:

- Payments: a mock gateway by default. A Razorpay adapter exists but is not yet verified against Razorpay's
  live sandbox. A self-hosted UPI option (YouPI-PG) is experimental and not bank-approved. Do not take real
  money before an independent security review.
- Personal data sits in a separate Postgres schema with per-customer encryption keys; erasing a customer
  deletes their key (crypto-shredding). There are runbooks for backup and restore, including a quarterly
  restore drill.
- Growing later does not mean a rewrite: the same code runs a `growth` profile (Meilisearch, NATS, OpenBao,
  Keycloak) on k3s. That tier is still being finished.

Status: v0.9 lite release candidate. Feedback on the Compose setup and the upgrade story is very welcome.

Repository: https://github.com/mukulkathuria/AgentBazaar
