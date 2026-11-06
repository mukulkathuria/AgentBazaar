# Runbook: database failover

**Applies to:** the growth and scale profiles: one primary, at least one synchronous standby, optional asynchronous
read replicas, and PgBouncer in front of the primary. Lite runs a single Postgres; for it see
[backup-restore.md](backup-restore.md).
**Owner:** [NAME] · **Last drill:** 2026-11-06 (automated on every push to `main`, see [Drill results](#drill-results))

## Topology and what it guarantees

```
API ──► PgBouncer (transaction pooling) ──► primary ══ sync ══► standby (promotion target)
 │                                             ╚═══ async ══► read replica(s)
 └──── safe GET reads (DATABASE_REPLICA_URLS) ──────────────► read replica(s)
```

- `DATABASE_URL` points at PgBouncer, never at a database host, so a failover changes one PgBouncer setting and no
  application configuration. `DATABASE_REPLICA_URLS` lists the read replicas; how reads are routed, and why a
  principal always sees its own writes, is in [ADR 0009](../adr/0009-replica-routing-and-read-your-writes.md).
- **No acknowledged write is lost** when the primary is configured with `synchronous_standby_names` naming the
  standby (for example `'FIRST 1 (standby_a, standby_b)'`) and `synchronous_commit = on` (the default; never turn it
  off for the API's role). Every commit the API has been told about is then flushed on a standby, and promoting
  that standby keeps it. An asynchronous replica can be behind: promote one only if no synchronous standby survives,
  and accept losing whatever it had not received.
- With exactly one synchronous standby, losing that standby stops the primary from acknowledging commits until it
  returns or `synchronous_standby_names` changes. Run two standbys with `FIRST 1 (...)` or `ANY 1 (...)` to avoid it.
- PgBouncer cannot carry the client's `statement_timeout` startup parameter in transaction pooling, so it ignores it
  (`ignore_startup_parameters = extra_float_digits,statement_timeout`). Set the limit on the role once:
  `ALTER ROLE agentbazaar SET statement_timeout = '15s';`. The API keeps no other session state between
  transactions (transaction-scoped advisory locks, `set_config(..., true)`, unnamed prepared statements, no
  `LISTEN`/`NOTIFY` or temporary tables), which the integration and e2e suites prove by running through PgBouncer
  in the Data tier workflow.
- Run Postgres containers with an init process (`init: true` in Compose, the default in Kubernetes). Without one, a
  healthcheck that times out leaves an orphan that is re-parented to the postmaster, and the postmaster treats its
  exit as a crashed backend and restarts the whole server. The drill hit exactly this before the fix.

## 1. Detect

- `/readyz` answers 503 "Database is not reachable"; writes fail or time out; PgBouncer logs
  `server conn crashed?` and then `server DNS lookup failed` or connection refusals for the primary.
- Reads keep working where they can: GET requests are served by replicas, which the API keeps judging against the
  last known primary position while the primary is away.
- Statements in flight when the primary dies fail with `server conn crashed?`. While PgBouncer cannot log in to the
  primary it either holds new queries in its queue (up to `query_wait_timeout`, 120 s by default) or, once a login
  has failed, answers them at once with `server login has been failing, cached error: ... (server_login_retry)`.
  Writes fail until the repoint and succeed again right after it; checkout and payment calls carry idempotency keys,
  so clients can retry them safely.

## 2. Decide: is the primary really gone?

- Confirm from two places (the PgBouncer host and another host, plus the cloud console or `docker ps`). A network
  partition can make a healthy primary look dead.
- **Fence the old primary before promoting anything**: stop the instance or container, or block its port, so it can
  never accept writes again. Two writable primaries (split brain) lose data in ways no tool can merge.

## 3. Promote the standby

1. Pick the target. On each candidate:
   ```sql
   SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();
   ```
   Choose the synchronous standby; among several, the one with the highest receive position.
2. Promote it and wait until it accepts writes:
   ```sql
   SELECT pg_promote(true, 60);   -- returns true once promotion has finished
   ```
3. On the new primary run `SHOW synchronous_standby_names;`. If it names standbys that are not connected, every
   commit will wait for them forever. Attach a standby first, or accept running without the zero-loss guarantee
   until one joins:
   ```sql
   ALTER SYSTEM SET synchronous_standby_names = '';
   SELECT pg_reload_conf();
   ```

## 4. Repoint PgBouncer

Change the host of the database entry and reload. PgBouncer closes server connections to the old host as they are
released and opens new ones to the new host; the API's client connections stay up and queued queries continue.

```bash
# Compose (growth): the image writes its config to /etc/pgbouncer/pgbouncer.ini at first start.
docker compose -f deploy/compose/docker-compose.yml exec pgbouncer \
  sed -i 's/host=postgres /host=<new-primary-host> /' /etc/pgbouncer/pgbouncer.ini
docker compose -f deploy/compose/docker-compose.yml exec pgbouncer \
  psql -h 127.0.0.1 -p 6432 -U agentbazaar pgbouncer -c RELOAD
```

On Kubernetes, update the ConfigMap or Secret that holds the `[databases]` section, then run `RELOAD` through the
admin console (or roll the PgBouncer pods; the API reconnects). `server_login_retry = 1` makes PgBouncer try the new
host within a second instead of the default 15.

## 5. Replicas, then the old primary

- The API stops reading from a replica that is promoted (no longer in recovery), unreachable or lagging, and starts
  again once it is healthy; nothing needs restarting. A promoted server left in `DATABASE_REPLICA_URLS` is ignored
  until the list is updated at the next deploy.
- Point the remaining replicas at the new primary (`primary_conninfo`, then restart), or re-clone them with
  `pg_basebackup`. They rejoin read rotation automatically once they have caught up.
- Never start the old primary as a primary again. Rebuild it as a standby of the new primary with `pg_rewind` (needs
  `wal_log_hints = on` or data checksums) or a fresh `pg_basebackup`, then add it back to
  `synchronous_standby_names`.

## 6. Verify

- On the new primary `SELECT pg_is_in_recovery();` returns `false`, and `pg_stat_replication` shows the standbys
  streaming with the expected `sync_state`.
- `/readyz` answers 200 and a test order goes through checkout.
- `agentbazaar_db_replica_healthy` is back to 1 for every replica, and
  `agentbazaar_db_reads_total{route="replica"}` is rising again.
- Close the incident as in [incident.md](incident.md#closing-the-incident), with the timings of each step.

## The automated drill

`apps/api/test/services/failover-drill.spec.ts` runs this runbook against [tests/infra/data-tier.yml](../../tests/infra/data-tier.yml)
(a primary, PgBouncer 1.26 in transaction pooling, an asynchronous replica and a standby):

1. makes the standby synchronous (`synchronous_standby_names = 'dt_standby'`) and checks `sync_state = 'sync'`;
2. starts four writers that insert through PgBouncer with the API's own pool and record every acknowledged id;
3. kills the primary with `SIGKILL` (`docker kill --signal KILL`), waits one second for "detection", promotes the
   standby with `pg_promote(true, 30)`, rewrites PgBouncer's database host and issues `RELOAD`;
4. keeps writing for two more seconds, then checks on the new primary that **every acknowledged id exists** and that
   the longest stretch without an acknowledged write stayed under the **30-second budget**.

Writes that failed in flight are reported separately: some of them may have committed (the acknowledgement was lost
with the server), which is not a loss. The Data tier workflow ([.github/workflows/data-tier.yml](../../.github/workflows/data-tier.yml))
runs the drill on every push to `main`, after the PgBouncer suites and the read-your-writes suite, and prints a
`FAILOVER DRILL {...}` line with the measurements. To run it yourself:

```bash
docker compose -f tests/infra/data-tier.yml up -d --wait
cd apps/api
DATA_TIER=1 pnpm exec vitest run --project services test/services/data-tier.spec.ts       # read-your-writes, lag, fallback
DATA_TIER=1 pnpm exec vitest run --project services test/services/failover-drill.spec.ts  # destructive: run last
cd ../..
docker compose -f tests/infra/data-tier.yml down -v
```

Where Docker runs inside WSL, also set `DATA_TIER_DOCKER="wsl.exe -d Debian --exec docker"`.

## Drill results

| Date | Where | Acknowledged writes | Lost | Failed writes (committed anyway) | `pg_promote` | Crash to repointed | Longest write outage | Budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-06 | GitHub Actions `ubuntu-latest`, [Data tier run 42198370506](https://github.com/mukulkathuria/AgentBazaar/actions/runs/42198370506) | 13,616 | **0** | 73 (1) | 0.11 s | 1.36 s | **2.23 s** | 30 s |
| 2026-11-06 | Developer laptop: Docker in WSL2 on Windows 11 | 627 | **0** | 4 (1) | 1.96 s | 14.09 s | 10.06 s | 30 s |

The write outage is the longest stretch in which no write was acknowledged: the crash, the one-second detection
stand-in, promotion, the PgBouncer edit and reload, and reconnection. Of the failed writes, 4 were in flight at the
crash (`server conn crashed?`) and the rest were refused by PgBouncer while it could not log in to a server
(`server login has been failing ... (server_login_retry)`). One failed write had committed before its
acknowledgement was lost, which is why failed writes are reported but never counted as lost. On the laptop every
Docker command crossed into WSL and took several seconds, which dominates its figures.

The same run passed the integration suite (8 files, 38 tests) and the e2e, contract, negative and regression suites
(17 files, 105 tests) through PgBouncer in transaction pooling, and the read-your-writes suite (3 tests); the whole
workflow took under two minutes.
