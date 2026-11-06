# Runbook: incidents

**Applies to:** lite profile on Docker Compose. The same switches exist in every profile.
**Policy, roles and notification decisions:** [../compliance/incident-response.md](../compliance/incident-response.md).

## Start here

1. Declare the incident, pick a severity (SEV1 to SEV3, defined in the
   [incident response plan](../compliance/incident-response.md#severity)) and open an incident record.
2. If personal data may be involved, **preserve evidence before changing anything** (step 3 below) and inform the
   incident lead and counsel.
3. Use the checks below to find out what is wrong, then the matching playbook.

```bash
COMPOSE="docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite"
PSQL="$COMPOSE exec -T postgres psql -U agentbazaar -d agentbazaar"
```

## Quick checks

| Check | Command | Healthy |
| --- | --- | --- |
| Containers | `$COMPOSE ps` | `api`, `web`, `postgres`, `valkey`, `caddy` running; `postgres` and `valkey` healthy |
| Liveness | `$COMPOSE exec api wget -qO- http://127.0.0.1:4000/healthz` | `{"status":"ok"}` |
| Readiness | `$COMPOSE exec api wget -qO- http://127.0.0.1:4000/readyz` | `"status":"ready"` and a small `outbox` backlog |
| API errors | `$COMPOSE logs api --since 30m \| grep -E '"level":(50\|60)'` | None or few |
| Startup config errors | `$COMPOSE logs api \| grep -i "Invalid configuration"` | None; a bad config exits with code 78 and lists every problem |
| Unpublished events | `$PSQL -c "SELECT count(*), min(created_at) FROM outbox_events WHERE published_at IS NULL"` | Small and recent |
| Failing events | `$PSQL -c "SELECT topic, attempts, last_error FROM outbox_events WHERE attempts > 3 AND published_at IS NULL LIMIT 20"` | No rows |
| Webhooks, last hour | `$PSQL -c "SELECT provider, outcome, count(*) FROM webhook_events WHERE received_at > now() - interval '1 hour' GROUP BY 1, 2"` | Mostly `applied` and `duplicate` |
| Failed refunds | `$PSQL -c "SELECT at, target, data FROM audit_log WHERE action = 'payment.refund_failed' ORDER BY at DESC LIMIT 20"` | No new rows |

Metrics are on `/metrics` inside the network (Caddy answers 404 for it publicly). Useful series:
`agentbazaar_http_request_duration_seconds` (by route and status), `agentbazaar_negotiation_decisions_total`
(by band, decision, channel), `agentbazaar_outbox_pending`, `agentbazaar_orders_created_total`. Start Prometheus and
Grafana with `--profile observability`.

## Playbooks

### A. API down or not ready

1. `$COMPOSE logs api --tail 200`. A configuration error lists the missing or invalid settings; fix `.env`.
2. A migration error ("was modified after it was applied") means the code and the database do not match: deploy
   the correct release, never edit an applied migration.
3. Database unreachable: check `postgres` health and disk space (`df -h`, `docker system df`).
4. Restart: `$COMPOSE up -d api`. If the database is lost, follow [backup-restore.md](backup-restore.md).

### B. Prices or discounts look wrong (possible floor leak)

The pricing engine never quotes at or below the floor by construction, so a wrong price usually means wrong
catalog data (cost, landed cost, margin) or a wrong band policy.

1. **Freeze negotiation.** For each band, set `negotiableBps` and `maxRounds` to 0 (keep `volumeTiers` if volume
   prices are fine), with an admin token from an MFA-verified session:

   ```bash
   curl -sS -X PUT "$API/api/v1/admin/policies" -H "authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"band":"standard","negotiableBps":0,"volumeTiers":[],"maxRounds":0,"approvalThresholdPaise":null,"quoteTtlSeconds":900,"concessionExponent":2}'
   ```

   Open negotiations re-read the policy on the next offer and fall back to the list price.
2. **Void quotes already issued** by rotating `QUOTE_SIGNING_KEY` ([key-rotation.md](key-rotation.md)). Quotes are
   single-use and expire anyway, but rotation stops them at once.
3. Find affected sales: `GET /api/v1/admin/negotiations`, or
   `$PSQL -c "SELECT id, sku, channel, list_unit_paise, final_unit_paise, created_at FROM negotiation_sessions WHERE final_unit_paise IS NOT NULL ORDER BY created_at DESC LIMIT 50"`.
4. Fix the catalog data or policy, then restore the policies.

### C. Model replies misbehave (wrong claims, leaked wording)

1. Set `LLM_ADAPTER=template` in `.env` and `$COMPOSE up -d api`. Replies then come only from the policy
   templates; no model is called.
2. Investigate in `llm_traces` (redacted, append-only): `guard_fallback = true` rows show replies the output guard
   refused and replaced with the template.

### D. Abusive traffic or a misbehaving agent

1. Confirm `DEMO_MODE` is **not** `true` in production: with it, anonymous callers get every scope.
2. Lower `RATE_LIMIT_PER_MINUTE` and restart. Per-agent quotas come from each client's `quota_per_minute`.
3. Disable a client: `$PSQL -c "UPDATE agent_clients SET status = 'disabled' WHERE client_id = '<id>'"` (no admin
   endpoint yet). Issued tokens stay valid until they expire (15 minutes); rotate `JWT_PRIVATE_KEY` to cut them
   off at once.
4. Block at the edge (Caddy, a firewall or your CDN) if traffic is volumetric.

### E. Suspected personal data exposure or stolen secrets

1. Preserve evidence: snapshot the `pgdata` volume or take a backup, export logs
   (`$COMPOSE logs --no-color > incident-<id>-logs.txt`), note the times.
2. Contain: remove the exposure path (close a port, revoke a credential, take `api` offline with
   `$COMPOSE stop api` if needed).
3. Rotate every secret that may be exposed ([key-rotation.md](key-rotation.md)). If `PII_MASTER_KEY` or the
   OpenBao token leaked together with database data, assume personal data is readable.
4. Work out scope with the breach assessment in the
   [incident response plan](../compliance/incident-response.md#personal-data-breach-assessment); counsel decides on
   notifications.

### F. Payments not confirming, or money without an order

Follow [payments-reconciliation.md](payments-reconciliation.md). Quick signs: many `invalid_signature` or `stale`
webhook outcomes (secret mismatch or clock skew), `amount_mismatch` outcomes (answered with HTTP 409), or orders
stuck in `pending_payment` or `payment_observed`.

### G. A secret was committed to the repository

Rotate it first, then remove it from history. Treat it as exposed from the moment it was pushed, even if the push
was quickly reverted.

## Closing the incident

1. Confirm the switches you used are back to normal (policies, `LLM_ADAPTER`, rate limits, `api` running).
2. Complete the incident record and the notification log.
3. Hold a blameless review. Every fixed bug gets a regression test before the fix merges.
4. Update this runbook with anything that was missing.
