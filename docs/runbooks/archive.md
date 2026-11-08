# Archiving old event logs

The append-only event logs are partitioned by UTC month ([ADR 0013](../adr/0013-time-partitioned-event-logs.md)):
`order_events`, `outbox_events`, `processed_events`, `webhook_events`, `analytics_events`, `audit_log` and
`llm_traces`. `cli archive` moves whole months out of Postgres into gzip JSON-lines files and drops them from the
database. Nothing else ever deletes from these tables.

## Run it

```bash
ARCHIVE_DIR=/srv/agentbazaar/archive pnpm --filter @agentbazaar/api cli archive --older-than 13
# or a fixed cutoff, and only some tables:
ARCHIVE_DIR=/srv/agentbazaar/archive pnpm --filter @agentbazaar/api cli archive --before 2026-01 --tables outbox_events,processed_events
```

- `--older-than N` keeps N whole months before the current one: in November 2026, `--older-than 13` keeps
  October 2025 onwards. `--before YYYY-MM` names the first month to keep. Give exactly one.
- The current month is never archived, whatever you ask for.
- `--tables` takes a comma-separated subset (default: all seven), so tables can have different windows.
- On Kubernetes the chart's `archive` CronJob runs `node dist/cli/index.js archive --older-than 13` nightly
  (`archive.*` in `deploy/helm/agentbazaar/values.yaml`; give it a volume with `archive.volume`).

For each partition it detaches the table, writes `ARCHIVE_DIR/<table>/<partition>.jsonl.gz` (one
`row_to_json` line per row, written to `.partial` and renamed when complete), reads the file back and compares
the row count and checksum with what Postgres computes from the table, writes `<partition>.manifest.json`, then
drops the table. A mismatch stops the run and keeps the table, detached.

It is safe to re-run at any time. Finished partitions are gone. A partition left detached by an interrupted or
failed run (crash, full disk, CronJob deadline) is picked up and archived again from the start. Outbox
partitions that still hold unpublished events are skipped and stay attached until the relay has delivered them.

## Choosing windows

| Table | Suggested hot window | Why |
| --- | --- | --- |
| `outbox_events`, `processed_events` | 2 months | Delivery bookkeeping; consumers only dedupe recent redeliveries |
| `webhook_events` | 2 months | Gateways retry for hours to days; the payment state machine ignores stale events anyway |
| `analytics_events`, `llm_traces` | 13 months | Year-over-year dashboards and cost reports |
| `order_events`, `audit_log` | 13 months or more | Archived rows stay in the files; set the files' retention with your CA and counsel (tax records: 6+ years) |

## Check an archive later

```bash
cat order_events_p202501.manifest.json        # rows, rowsChecksum, sha256 of the .gz
sha256sum order_events_p202501.jsonl.gz       # must equal the manifest's sha256
gunzip -c order_events_p202501.jsonl.gz | wc -l   # must equal rows
```

## Restore a month

Recreate the month's partition (it was dropped), then load the lines back through `jsonb_populate_record`:

```sql
SELECT ensure_month_partitions('order_events', 0, '2025-01-01');  -- creates every missing month up to now
CREATE TEMP TABLE restore (line jsonb);
-- CSV with control characters as quote and delimiter: each line arrives untouched (text format would unescape it).
\copy restore (line) FROM PROGRAM 'gunzip -c /srv/agentbazaar/archive/order_events/order_events_p202501.jsonl.gz' WITH (FORMAT csv, QUOTE e'\x01', DELIMITER e'\x02')
INSERT INTO order_events OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::order_events, line)).* FROM restore;
```

## Personal data

Archives hold event rows as stored, and event rows reference customers by token only (`cus_...`,
`customer:<token>`); names, contact details and addresses live encrypted in the `pii` schema, which is never
archived. Erasing a customer later crypto-shreds their `pii` record, so tokens in old archives can no longer be
resolved to a person and the archives need no rewriting. Free text in these logs (audit data, LLM traces) is
redacted before it is stored. Anonymous subjects (`anon:<hash of IP>`) are pseudonymous; see the
[data map](../compliance/data-map.md). Keep `ARCHIVE_DIR` as access-controlled as your database backups.
