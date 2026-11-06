# Runbook: backup and restore

**Applies to:** lite profile on Docker Compose (one VPS). Notes for AWS and the growth/scale profiles at the end.
**Owner:** [NAME] · **Last drill:** [DATE]

> **No backup job ships with the software yet.** Docker Compose runs Postgres with a named volume and nothing
> copies it anywhere. Until a scheduled job exists in the repository (planned), setting one up is the operator's
> responsibility. Do it before you take a real order.

## What to back up

| Item | Where | How | Notes |
| --- | --- | --- | --- |
| Postgres database `agentbazaar` | Compose volume `pgdata` (image `pgvector/pgvector:pg18`) | `pg_dump` (below) | Everything: catalog, orders, invoices, encrypted PII, audit trail |
| Secrets in `.env` | The host | Copy to a password manager or secrets manager | **Store separately from database backups** (see below) |
| Caddy data | Compose volume `caddy_data` | Volume copy | TLS certificates and ACME account; can be re-issued, so optional |
| Valkey | Compose service `valkey` | Not needed | Runs with persistence off (`--save ''`, `--appendonly no`); holds only cache, rate-limit and quota counters |
| Demo data (PGlite) | Memory or `PGLITE_DATA_DIR` | Not needed | PGlite is for the demo and tests only, never for real customers |

### Why keys must be stored apart from the database

Personal data is encrypted with per-customer keys that are wrapped by `PII_MASTER_KEY`; logins and email lookups
use blind indexes keyed by `PII_BLIND_INDEX_KEY`.

- A database backup **without** these keys cannot be used to read personal data or to sign customers in. Lose the
  keys and you lose all customer data, even with a perfect backup.
- A database backup **together with** these keys exposes all personal data. Never put them in the same bucket,
  archive or account. Limit who can access each, ideally different people.

Keep the old key material for as long as any backup made with it still exists (see
[key-rotation.md](key-rotation.md)).

## Taking a backup

Run from the repository directory on the host.

```bash
COMPOSE="docker compose -f deploy/compose/docker-compose.yml --env-file .env --profile lite"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# 1. Logical dump in custom format (consistent snapshot of the whole database).
$COMPOSE exec -T postgres pg_dump -U agentbazaar -d agentbazaar --format=custom > "agentbazaar-$STAMP.dump"

# 2. Check the archive is readable.
$COMPOSE exec -T postgres pg_restore --list < "agentbazaar-$STAMP.dump" > /dev/null && echo "dump readable"

# 3. Manifest for verifying a restore later.
$COMPOSE exec -T postgres psql -U agentbazaar -d agentbazaar -At -c "
  SELECT 'schema_version', max(version) FROM schema_migrations
  UNION ALL SELECT 'orders', count(*)::text FROM orders
  UNION ALL SELECT 'invoices', count(*)::text FROM invoices
  UNION ALL SELECT 'customers', count(*)::text FROM pii.customers
  UNION ALL SELECT 'payments', count(*)::text FROM payments" > "agentbazaar-$STAMP.manifest"

# 4. Encrypt before the file leaves the host (age shown; any audited tool works), then upload.
age -r "$BACKUP_AGE_RECIPIENT" -o "agentbazaar-$STAMP.dump.age" "agentbazaar-$STAMP.dump"
aws s3 cp "agentbazaar-$STAMP.dump.age" "s3://$BACKUP_BUCKET/postgres/"
aws s3 cp "agentbazaar-$STAMP.manifest" "s3://$BACKUP_BUCKET/postgres/"
shred -u "agentbazaar-$STAMP.dump"
```

Schedule it with cron or a systemd timer at the frequency your recovery point objective needs:
[RPO TARGET] → [SCHEDULE]. Alert when a run fails or when no new backup has appeared for longer than that.

**Point-in-time recovery** is not configured in the Compose stack. A `pg_dump` loses everything since the last
dump. If that window is too large, add continuous WAL archiving (for example pgBackRest or WAL-G) or move the
database to a managed service; both are operator choices today.

## Restoring

Use this both for real recovery and for the drill. Restore into a fresh environment first whenever you can.

1. **Prepare the host** with the same AgentBazaar release that took the backup, or a newer one. Create `.env` with
   the **same** `PII_MASTER_KEY` and `PII_BLIND_INDEX_KEY` as the source. Keep `QUOTE_SIGNING_KEY` and
   `JWT_PRIVATE_KEY` too unless they were compromised. For a drill, also set `PAYMENT_ADAPTER=mock` and leave
   `MAILER=log` so the copy cannot call a gateway or email anyone.
2. **Start only Postgres** and wait for it to be healthy:

   ```bash
   $COMPOSE up -d postgres
   ```

3. **Restore the dump:**

   ```bash
   age -d -i "$BACKUP_AGE_KEY" -o restore.dump "agentbazaar-<STAMP>.dump.age"
   $COMPOSE exec -T postgres pg_restore -U agentbazaar -d agentbazaar --clean --if-exists --no-owner < restore.dump
   ```

4. **Start the stack:** `$COMPOSE up -d`. On boot the API applies any newer migrations forward. It refuses to
   start if a migration that was already applied has a different checksum; that means the release does not match
   the backup.
5. **Verify:**
   - `$COMPOSE exec api wget -qO- http://127.0.0.1:4000/readyz` returns `"status":"ready"`.
   - The manifest counts match (newer migrations may add tables, never remove rows).
   - Sign in with a known test account and open the account page: the email shows, so the keys match.
   - Invoice numbering continues: `SELECT financial_year, last_number FROM invoice_counters;` matches the highest
     invoice number for each financial year.
6. **Re-apply erasures** received after the backup was taken. A restore brings back customers who were erased
   later, and backups cannot be crypto-shredded. Keep a record of erasure requests outside the database (for
   example your grievance inbox or ticketing system) for exactly this step.
7. **Reconcile payments and orders** made after the backup was taken. Payments captured, webhooks received and
   orders placed in that window are missing from the restored database. Compare against your gateway dashboard,
   settlement reports and the YouPI-PG ledger ([payments-reconciliation.md](payments-reconciliation.md)), and
   treat any lost orders as an incident ([incident.md](incident.md)).
8. **Point traffic** at the restored stack (DNS or Caddy) and watch error rates.

Events in the transactional outbox that were not yet published at backup time are delivered again after the
restore. Consumers record every event they process, so a redelivery has no duplicate effect.

## Quarterly restore drill

The project plan requires a restore drill every quarter. Restore the latest production backup into an isolated
environment using the steps above, then fill in:

```text
Date / people:                  [ ]
Backup used (timestamp, size):  [ ]
Time from start to /readyz:     [ ]   (measured recovery time)
Data window lost:               [ ]   (backup age at failure time; measured recovery point)
Manifest matched:               [yes/no, differences]
Test account readable:          [yes/no]
Invoice numbering continuous:   [yes/no]
Problems and fixes:             [ ]
Next drill:                     [ ]
```

Delete the restored copy afterwards; it contains personal data.

## AWS and growth/scale notes

- The lite OpenTofu/Terraform profile (`deploy/terraform/profiles/lite`) creates a KMS-encrypted `backups` bucket
  and lets the host write to it. The storage module's default lifecycle moves backups to infrequent access after
  30 days and expires them after 90 (`deploy/terraform/modules/storage/variables.tf`); check your values, because
  this window also decides how long erased data survives in backups. The host's data volume is separate from the
  instance and leaves a final snapshot on destroy. Neither replaces a scheduled backup.
- When the database runs on a managed service through `deploy/terraform/modules/database`, automated backups and
  point-in-time restore cover `backup_retention_days`. A point-in-time restore creates a new database: restore,
  then change `DATABASE_URL` and follow steps 4 to 8.
- The scale example (`deploy/terraform/examples/scale.tfvars`) copies AWS Backup recovery points to a second
  region (`backup_copy_region`).
