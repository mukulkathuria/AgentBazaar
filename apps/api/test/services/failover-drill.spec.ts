import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresDatabase } from '../../src/shared/db/database.js';
import { DATA_TIER, docker, PGBOUNCER_URL, PRIMARY_URL, sleep, STANDBY_URL, waitFor, withUrl } from './data-tier.js';

/** Stated recovery objective: the longest time no write is acknowledged, from the crash to the new primary. */
const RECOVERY_BUDGET_MS = 30_000;
/** Stands in for the alert that pages the operator or wakes the failover manager. */
const DETECTION_MS = 1_000;
const WRITERS = 4;

/**
 * Failover drill on tests/infra/data-tier.yml (destructive: it kills the primary, so it runs last).
 * Writers insert through PgBouncer with the app's own pool and record every acknowledged id. The primary is
 * killed with SIGKILL, the synchronous standby is promoted, PgBouncer is repointed and reloaded (the runbook's
 * steps, docs/runbooks/database-failover.md), and every acknowledged id must exist on the new primary.
 */
describe.skipIf(!DATA_TIER)('@growth failover drill: synchronous standby, kill -9, promote, repoint PgBouncer', () => {
  it('loses no acknowledged write and recovers within the stated budget', async () => {
    const primary = createPostgresDatabase({ url: PRIMARY_URL, poolMax: 1 });
    await primary.query(`ALTER SYSTEM SET synchronous_standby_names = 'dt_standby'`);
    await primary.query('SELECT pg_reload_conf()');
    await waitFor('dt_standby to become synchronous', async () => {
      const [r] = await primary.query<{ s: string }>(`SELECT sync_state AS s FROM pg_stat_replication WHERE application_name = 'dt_standby'`);
      return r?.s === 'sync';
    });
    await primary.query('DROP DATABASE IF EXISTS dt_drill WITH (FORCE)');
    await primary.query('CREATE DATABASE dt_drill');
    await primary.close();

    const app = createPostgresDatabase({ url: withUrl(PGBOUNCER_URL, { database: 'dt_drill' }), poolMax: WRITERS });
    await app.query('CREATE TABLE drill_writes (id bigint PRIMARY KEY, written_at timestamptz NOT NULL DEFAULT now())');

    /** Acknowledged id -> when the acknowledgement arrived. */
    const acked = new Map<number, number>();
    const failed: number[] = [];
    const errors = new Map<string, number>();
    let next = 1;
    let stopped = false;
    const writer = async (): Promise<void> => {
      while (!stopped) {
        const id = next++;
        try {
          await app.query('INSERT INTO drill_writes (id) VALUES ($1)', [id]);
          acked.set(id, Date.now());
        } catch (err) {
          failed.push(id);
          const message = (err as Error).message;
          errors.set(message, (errors.get(message) ?? 0) + 1);
          await sleep(50);
        }
      }
    };
    const writers = Array.from({ length: WRITERS }, writer);
    await waitFor('writes before the crash', () => acked.size >= 200);
    const ackedBeforeKill = acked.size;

    const killStartedAt = Date.now();
    await docker('kill', '--signal', 'KILL', 'ab-dt-primary-1');
    await sleep(DETECTION_MS);
    const standby = createPostgresDatabase({ url: STANDBY_URL, poolMax: 1 });
    const promoteStartedAt = Date.now();
    const [promoted] = await standby.query<{ ok: boolean }>('SELECT pg_promote(true, 30) AS ok');
    expect(promoted?.ok).toBe(true);
    const promotedAt = Date.now();
    await docker('exec', 'ab-dt-pgbouncer-1', 'sed', '-i', 's/host=primary /host=standby /', '/etc/pgbouncer/pgbouncer.ini');
    const adminConsole = new pg.Client({ connectionString: withUrl(PGBOUNCER_URL, { database: 'pgbouncer' }) });
    await adminConsole.connect();
    await adminConsole.query('RELOAD');
    await adminConsole.end();
    const repointedAt = Date.now();

    await waitFor('writes on the new primary', () => [...acked.values()].some((at) => at > repointedAt), RECOVERY_BUDGET_MS);
    await sleep(2_000);
    stopped = true;
    await Promise.all(writers);
    await app.close();

    // The outage as the writers saw it: the longest stretch without an acknowledged write.
    const times = [...acked.values()].sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const outageMs = Math.max(...gaps);

    const newPrimary = createPostgresDatabase({ url: withUrl(STANDBY_URL, { database: 'dt_drill' }), poolMax: 1 });
    const present = async (ids: number[]): Promise<number> =>
      (await newPrimary.query<{ n: number }>('SELECT count(*)::int AS n FROM drill_writes WHERE id = ANY($1::bigint[])', [ids]))[0]!.n;
    const [state] = await newPrimary.query<{ standby: boolean }>('SELECT pg_is_in_recovery() AS standby');
    const report = {
      ackedBeforeKill,
      ackedTotal: acked.size,
      ackedAfterRepoint: times.filter((t) => t > repointedAt).length,
      lost: acked.size - (await present([...acked.keys()])),
      failedAttempts: failed.length,
      failedButCommitted: await present(failed),
      errors: Object.fromEntries(errors),
      killToPromotedSeconds: (promotedAt - killStartedAt) / 1_000,
      promoteSeconds: (promotedAt - promoteStartedAt) / 1_000,
      killToRepointedSeconds: (repointedAt - killStartedAt) / 1_000,
      writeOutageSeconds: outageMs / 1_000,
      budgetSeconds: RECOVERY_BUDGET_MS / 1_000,
    };
    await newPrimary.close();
    await standby.close();

    process.stdout.write(`FAILOVER DRILL ${JSON.stringify(report)}\n`);
    expect(state?.standby).toBe(false);
    expect(report.lost).toBe(0);
    expect(outageMs).toBeLessThan(RECOVERY_BUDGET_MS);
  }, 120_000);
});
