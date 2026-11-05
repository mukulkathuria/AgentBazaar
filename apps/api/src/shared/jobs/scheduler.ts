import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { inTransaction, one, type Executor } from '../db/database.js';

export interface Job {
  name: string;
  everyMs: number;
  run: (db: Executor) => Promise<number | void>;
}

/**
 * Runs periodic jobs (reservation expiry, retention deletion). Each run takes a transaction-level
 * advisory lock, so with several instances only one executes a given job at a time.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly timers: NodeJS.Timeout[] = [];
  private stopped = true;

  constructor(
    private readonly db: Executor,
    private readonly logger?: Logger,
  ) {}

  register(job: Job): void {
    if (this.jobs.has(job.name)) throw new Error(`Duplicate job ${job.name}`);
    this.jobs.set(job.name, job);
  }

  /** Runs one job now. Returns null if another instance holds the lock. */
  async runOnce(name: string): Promise<number | null> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);
    const locked = await inTransaction(this.db, async (tx) => {
      const r = await one<{ ok: boolean }>(tx, sql`SELECT pg_try_advisory_xact_lock(hashtext(${`job:${name}`})) AS ok`);
      return r?.ok ? ((await job.run(tx)) ?? 0) : null;
    });
    return locked;
  }

  async runAll(): Promise<void> {
    for (const name of this.jobs.keys()) await this.runOnce(name);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const job of this.jobs.values()) {
      const t = setInterval(() => {
        if (this.stopped) return;
        this.runOnce(job.name).catch((err: unknown) => this.logger?.error({ err, job: job.name }, 'job failed'));
      }, job.everyMs);
      t.unref?.();
      this.timers.push(t);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearInterval(t);
  }
}
