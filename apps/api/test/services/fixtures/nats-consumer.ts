/**
 * A durable NATS JetStream consumer in its own process, for apps/api/test/services/messaging.spec.ts.
 * Every `t4.effect` event inserts one row into t4_effects in the consumer's transaction. With
 * CRASH_AT set, it tells the parent (IPC "crash-point") and hangs when it reaches CRASH_EVENT, so the
 * parent can SIGKILL it there: `before-effect` inside the handler, before writing anything;
 * `after-commit` once the transaction (effect + processed_events) committed but before the ack.
 */
import { sql } from 'drizzle-orm';
import { createPostgresDatabase, type Executor } from '../../../src/shared/db/database.js';
import { createLogger } from '../../../src/shared/observability/logger.js';
import { createNatsBus } from '../../../src/shared/outbox/broker-bus.js';

const { DATABASE_URL, NATS_URL, STREAM, CONSUMER, CRASH_AT, CRASH_EVENT } = process.env;
const database = createPostgresDatabase({ url: DATABASE_URL!, poolMax: 2, applicationName: 't4-nats-consumer' });
let crashAfterCommit = false;

const hang = async (): Promise<never> => {
  process.send?.('crash-point');
  return new Promise<never>(() => undefined);
};

// Wraps transactions so the process can stop between COMMIT and the bus's ack.
const db = new Proxy(database.db, {
  get(target, prop, receiver) {
    if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
    return async (fn: Parameters<Executor['transaction']>[0]) => {
      const result = await target.transaction(fn);
      if (crashAfterCommit) await hang();
      return result;
    };
  },
});

const bus = await createNatsBus(NATS_URL!, db, createLogger('silent'), STREAM);
bus.subscribe({
  consumer: CONSUMER!,
  topics: ['t4.effect'],
  handler: async (event, tx) => {
    const crashing = event.id === CRASH_EVENT;
    if (crashing && CRASH_AT === 'before-effect') await hang();
    await tx.execute(sql`INSERT INTO t4_effects (consumer, event_id, n) VALUES (${CONSUMER}, ${event.id}, ${Number(event.payload.n)})`);
    crashAfterCommit = crashing && CRASH_AT === 'after-commit';
  },
});
process.send?.('ready');
