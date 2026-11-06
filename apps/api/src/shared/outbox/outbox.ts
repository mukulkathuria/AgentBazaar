import { sql } from 'drizzle-orm';
import { inTransaction, one, rows, type Executor } from '../db/database.js';

export interface OutboxEvent<P = Record<string, unknown>> {
  id: string;
  topic: string;
  aggregateId: string;
  payload: P;
  createdAt: Date;
}

/** Appends an event in the caller's transaction, so the event exists if and only if the change does. */
export async function appendEvent(
  ex: Executor,
  topic: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await ex.execute(
    sql`INSERT INTO outbox_events (topic, aggregate_id, payload) VALUES (${topic}, ${aggregateId}, ${JSON.stringify(payload)}::jsonb)`,
  );
}

export type EventHandler = (event: OutboxEvent, tx: Executor) => Promise<void>;

export interface Subscription {
  consumer: string;
  topics: readonly string[];
  handler: EventHandler;
}

/**
 * Event bus port. The in-process bus (lite) runs consumers directly; NATS (growth) and Kafka
 * (scale) adapters publish to a broker and consume from it. Consumers are idempotent either way.
 */
export interface EventBus {
  subscribe(sub: Subscription): void;
  publish(events: OutboxEvent[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Runs `handler` at most once per (consumer, event) by recording the event in the same
 * transaction as the handler's own writes. A failure rolls both back, so the event is retried.
 */
export async function runIdempotent(db: Executor, consumer: string, event: OutboxEvent, handler: EventHandler): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const claimed = await one<{ event_id: string }>(
      tx,
      sql`INSERT INTO processed_events (consumer, event_id) VALUES (${consumer}, ${event.id})
          ON CONFLICT DO NOTHING RETURNING event_id`,
    );
    if (!claimed) return false;
    await handler(event, tx);
    return true;
  });
}

export const matchesTopic = (topics: readonly string[], topic: string): boolean =>
  topics.some((t) => t === topic || t === '*' || (t.endsWith('.*') && topic.startsWith(t.slice(0, -1))));

export class InProcessEventBus implements EventBus {
  private readonly subs: Subscription[] = [];

  constructor(private readonly db: Executor) {}

  subscribe(sub: Subscription): void {
    if (this.subs.some((s) => s.consumer === sub.consumer)) throw new Error(`Duplicate consumer ${sub.consumer}`);
    this.subs.push(sub);
  }

  async publish(events: OutboxEvent[]): Promise<void> {
    const failures: string[] = [];
    for (const event of events) {
      for (const sub of this.subs) {
        if (!matchesTopic(sub.topics, event.topic)) continue;
        try {
          await runIdempotent(this.db, sub.consumer, event, sub.handler);
        } catch (err) {
          failures.push(`${sub.consumer}@${event.id}: ${(err as Error).message}`);
        }
      }
    }
    if (failures.length) throw new Error(`Consumers failed: ${failures.join('; ')}`);
  }

  async close(): Promise<void> {}
}

interface Row {
  id: string;
  topic: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: Date;
  attempts: number;
  seq: number;
}

export interface RelayOptions {
  batchSize?: number;
  idleMs?: number;
  busyMs?: number;
  maxBackoffMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Polls the outbox and publishes events in order. Events are claimed with a short lease in one
 * auto-committed statement (FOR UPDATE SKIP LOCKED), then published outside any transaction, so
 * consumers can open their own transactions and several instances can relay in parallel. A relay
 * that dies mid-batch simply lets the lease lapse and another instance retries; consumers are
 * idempotent, so a repeat is harmless. Failed events back off exponentially.
 *
 * Per-aggregate order: only an aggregate's earliest unpublished event (by insert sequence, which
 * for one aggregate is commit order) is ever claimed, so its later events wait while it is leased by
 * another relay or backing off after a failure. Events of different aggregates are not held back.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private draining: Promise<number> | undefined;

  constructor(
    private readonly db: Executor,
    private readonly bus: EventBus,
    private readonly opts: RelayOptions = {},
  ) {}

  /** Processes one batch. Returns how many events were attempted. */
  async tick(): Promise<number> {
    const batch = this.opts.batchSize ?? 100;
    const claimed = await rows<Row>(
      this.db,
      sql`UPDATE outbox_events SET next_attempt_at = now() + interval '30 seconds'
          WHERE id IN (
            SELECT e.id FROM outbox_events e WHERE e.published_at IS NULL AND e.next_attempt_at <= now()
              AND NOT EXISTS (SELECT 1 FROM outbox_events p
                              WHERE p.aggregate_id = e.aggregate_id AND p.published_at IS NULL AND p.seq < e.seq)
            ORDER BY e.seq LIMIT ${batch} FOR UPDATE SKIP LOCKED)
          RETURNING id, topic, aggregate_id, payload, created_at, attempts, seq`,
    );
    claimed.sort((a, b) => a.seq - b.seq);
    for (const r of claimed) {
      const event: OutboxEvent = { id: r.id, topic: r.topic, aggregateId: r.aggregate_id, payload: r.payload, createdAt: r.created_at };
      try {
        await this.bus.publish([event]);
        await this.db.execute(sql`UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = ${r.id}`);
      } catch (err) {
        const backoffMs = Math.min(this.opts.maxBackoffMs ?? 60_000, 250 * 2 ** r.attempts);
        await this.db.execute(
          sql`UPDATE outbox_events SET attempts = attempts + 1, last_error = ${String((err as Error).message).slice(0, 500)},
              next_attempt_at = now() + (${backoffMs} * interval '1 millisecond') WHERE id = ${r.id}`,
        );
        this.opts.onError?.(err);
      }
    }
    return claimed.length;
  }

  /** Publishes until nothing is due. Used by tests, the demo and graceful shutdown. */
  async drain(maxBatches = 1000): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        const n = await this.tick();
        total += n;
        if (n === 0) break;
      }
      return total;
    })().finally(() => (this.draining = undefined));
    return this.draining;
  }

  /** Wakes the relay immediately (called after a commit that wrote events). */
  kick(): void {
    if (this.stopped || this.running) return;
    clearTimeout(this.timer);
    this.schedule(0);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.loop(), ms);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    let n = 0;
    try {
      n = await this.drain(10);
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.running = false;
    }
    if (!this.stopped) this.schedule(n > 0 ? (this.opts.busyMs ?? 50) : (this.opts.idleMs ?? 500));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.draining?.catch(() => undefined);
  }
}

/** Pending outbox depth, exported as a metric and used by readiness checks. */
export async function outboxLag(db: Executor): Promise<{ pending: number; oldestSeconds: number }> {
  const r = await one<{ pending: number; oldest: number | null }>(
    db,
    sql`SELECT count(*)::int AS pending, extract(epoch FROM now() - min(created_at))::float AS oldest
        FROM outbox_events WHERE published_at IS NULL`,
  );
  return { pending: r?.pending ?? 0, oldestSeconds: Math.round(r?.oldest ?? 0) };
}
