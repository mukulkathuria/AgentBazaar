import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction, rows, type Executor } from '../../src/shared/db/database.js';
import { appendEvent, OutboxRelay, type EventBus, type OutboxEvent } from '../../src/shared/outbox/outbox.js';
import { createTestDb, type TestDb } from '../support/test-db.js';

/** Records what it publishes; `fail` decides which events throw, `delayMs` lets concurrent relays interleave. */
function recordingBus(opts: { fail?: (e: OutboxEvent) => boolean; delayMs?: number } = {}) {
  const published: OutboxEvent[] = [];
  const bus: EventBus = {
    subscribe: () => undefined,
    async publish(events) {
      for (const e of events) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 0));
        if (opts.fail?.(e)) throw new Error(`refused ${String(e.payload.n)}`);
        published.push(e);
      }
    },
    close: async () => undefined,
  };
  const order = (aggregate: string) => published.filter((e) => e.aggregateId === aggregate).map((e) => e.payload.n);
  return { bus, published, order };
}

describe('@lite outbox relay keeps each aggregate in commit order', () => {
  let t: TestDb;
  let db: Executor;
  const append = (aggregate: string, from: number, count: number) =>
    inTransaction(db, async (tx) => {
      for (let n = from; n < from + count; n++) await appendEvent(tx, 'test.step', aggregate, { n });
    });

  beforeAll(async () => {
    t = await createTestDb({ poolMax: 4 });
    db = t.database.db;
  });
  beforeEach(async () => db.execute(sql`DELETE FROM outbox_events`));
  afterAll(async () => t.cleanup());

  it('publishes several events of one transaction in the order they were appended', async () => {
    await append('a', 1, 6);
    await append('b', 1, 6);
    await append('a', 7, 2);
    const r = recordingBus();
    await new OutboxRelay(db, r.bus).drain();
    expect(r.order('a')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.order('b')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('holds back an aggregate behind a failing event without blocking other aggregates', async () => {
    await append('a', 1, 4);
    await append('b', 1, 3);
    let refuse = true;
    const r = recordingBus({ fail: (e) => refuse && e.aggregateId === 'a' && e.payload.n === 2 });
    const relay = new OutboxRelay(db, r.bus);
    await relay.drain();
    expect(r.order('a')).toEqual([1]);
    expect(r.order('b')).toEqual([1, 2, 3]);
    const [failed] = await rows<{ attempts: number; last_error: string }>(
      db,
      sql`SELECT attempts, last_error FROM outbox_events WHERE aggregate_id = 'a' AND published_at IS NULL ORDER BY seq LIMIT 1`,
    );
    expect(failed).toEqual({ attempts: 1, last_error: 'refused 2' });

    refuse = false;
    await db.execute(sql`UPDATE outbox_events SET next_attempt_at = now() WHERE published_at IS NULL`); // the backoff has passed
    await relay.drain();
    expect(r.order('a')).toEqual([1, 2, 3, 4]);
  });

  it('never reorders an aggregate when several relays drain at once', async () => {
    for (let n = 1; n <= 30; n += 3) for (const aggregate of ['a', 'b', 'c']) await append(aggregate, n, 3);
    const r = recordingBus({ delayMs: 1 });
    const pending = async () =>
      (await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`))[0]!.n;
    // Each relay keeps polling until everything is out, as running instances do (pausing when it finds nothing).
    const run = async (relay: OutboxRelay) => {
      while ((await pending()) > 0) if (!(await relay.tick())) await new Promise((resolve) => setTimeout(resolve, 2));
    };
    await Promise.all([1, 2, 3].map(() => run(new OutboxRelay(db, r.bus, { batchSize: 7 }))));
    expect(r.published).toHaveLength(90);
    for (const aggregate of ['a', 'b', 'c']) expect(r.order(aggregate)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});
