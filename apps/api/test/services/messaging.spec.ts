import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateCatalog } from '@agentbazaar/testkit';
import { sql } from 'drizzle-orm';
import { Kafka, logLevel, type Admin } from 'kafkajs';
import { connect } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '../../src/modules/catalog/index.js';
import { InventoryService } from '../../src/modules/inventory/index.js';
import { SearchIndexer } from '../../src/modules/search/application/search-indexer.js';
import { HashEmbeddings } from '../../src/modules/search/domain/embeddings.js';
import { PgSearchAdapter } from '../../src/modules/search/infrastructure/pg-search.adapter.js';
import { inTransaction, one, rows, type Executor } from '../../src/shared/db/database.js';
import { systemClock } from '../../src/shared/kernel/clock.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import { createKafkaBus, createNatsBus } from '../../src/shared/outbox/broker-bus.js';
import { appendEvent, OutboxRelay, type EventBus, type Subscription } from '../../src/shared/outbox/outbox.js';
import { createTestDb, type TestDb } from '../support/test-db.js';

const API_DIR = fileURLToPath(new URL('../..', import.meta.url));
const CONSUMER_SCRIPT = fileURLToPath(new URL('./fixtures/nats-consumer.ts', import.meta.url));
const logger = createLogger('silent');
const suffix = () => randomUUID().slice(0, 8);

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const count = async (db: Executor, query: ReturnType<typeof sql>) => (await one<{ n: number }>(db, query))!.n;

describe('@growth NATS JetStream: a consumer killed mid-message loses nothing and applies nothing twice', () => {
  const stream = `T4_${suffix().toUpperCase()}`;
  const children: ChildProcess[] = [];
  let t: TestDb;
  let db: Executor;
  let publisher: EventBus;
  let events: string[];

  const inbox = new Map<ChildProcess, unknown[]>();
  /** A consumer process; resolves once it has subscribed. */
  async function startConsumer(env: Record<string, string>): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['--import', 'tsx', CONSUMER_SCRIPT], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: t.url!, STREAM: stream, ...env },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.push(child);
    const received: unknown[] = [];
    inbox.set(child, received);
    child.on('message', (m) => received.push(m));
    await message(child, 'ready');
    return child;
  }
  const message = (child: ChildProcess, expected: string) =>
    until(`consumer to report "${expected}"`, async () => {
      if (child.exitCode !== null) throw new Error(`consumer exited with ${child.exitCode} before "${expected}"`);
      return inbox.get(child)!.includes(expected);
    });
  const kill = async (child: ChildProcess) => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  };
  const applied = async (consumer: string) =>
    (await rows<{ event_id: string }>(db, sql`SELECT event_id FROM t4_effects WHERE consumer = ${consumer} ORDER BY applied`)).map(
      (r) => r.event_id,
    );

  beforeAll(async () => {
    t = await createTestDb({ poolMax: 4 });
    db = t.database.db;
    await db.execute(sql`CREATE TABLE t4_effects (consumer text NOT NULL, event_id uuid NOT NULL, n int NOT NULL, applied bigserial)`);
    publisher = await createNatsBus(process.env.NATS_URL!, db, logger, stream);
    for (let n = 1; n <= 20; n += 4) {
      await inTransaction(db, async (tx) => {
        for (let k = n; k < n + 4; k++) await appendEvent(tx, 't4.effect', 'cart-1', { n: k });
      });
    }
    expect(await new OutboxRelay(db, publisher).drain()).toBe(20);
    events = (await rows<{ id: string }>(db, sql`SELECT id FROM outbox_events ORDER BY seq`)).map((r) => r.id);
  }, 120_000);
  afterAll(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await publisher?.close();
    const nc = await connect({ servers: process.env.NATS_URL! });
    await (await nc.jetstreamManager()).streams.delete(stream).catch(() => false);
    await nc.close();
    await t?.cleanup();
  });

  it.each(['before-effect', 'after-commit'] as const)(
    'SIGKILL %s: the restarted consumer applies every event exactly once',
    async (crashAt) => {
      const consumer = `t4-${crashAt}`;
      const first = await startConsumer({ CONSUMER: consumer, CRASH_AT: crashAt, CRASH_EVENT: events[7]! });
      await message(first, 'crash-point');
      await kill(first);
      // Events before the crash point are applied once; the crash event only if its transaction committed.
      expect(await applied(consumer)).toEqual(events.slice(0, crashAt === 'after-commit' ? 8 : 7));

      // The broker redelivers what was never acknowledged once the ack wait (30 s) runs out.
      const second = await startConsumer({ CONSUMER: consumer });
      const nc = await connect({ servers: process.env.NATS_URL! });
      const jsm = await nc.jetstreamManager();
      await until('every message acknowledged', async () => {
        const info = await jsm.consumers.info(stream, consumer);
        return info.num_pending === 0 && info.num_ack_pending === 0 && info.delivered.consumer_seq >= 20;
      });
      await nc.close();
      await kill(second);
      const final = await applied(consumer);
      expect(final).toHaveLength(20);
      expect(new Set(final)).toEqual(new Set(events));
      expect(await count(db, sql`SELECT count(*)::int AS n FROM processed_events WHERE consumer = ${consumer}`)).toBe(20);
    },
    240_000,
  );
});

describe('@scale Kafka: per-key order across partitions, idempotent replay and a rebuilt read model', () => {
  const topic = `t4_events_${suffix()}`;
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
  const buses: EventBus[] = [];
  const ordering = `t4-order-${suffix()}`;
  let admin: Admin;
  let t: TestDb;
  let db: Executor;
  let publisher: EventBus;

  const bus = async (sub?: Subscription) => {
    const b = await createKafkaBus(brokers, db, logger, topic);
    buses.push(b);
    if (sub) b.subscribe(sub);
    return b;
  };
  const pending = () => count(db, sql`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
  /** Several relays poll until the outbox is empty, as running API instances do. */
  const relayAll = async (relays: number) => {
    const run = async (relay: OutboxRelay) => {
      while ((await pending()) > 0) if (!(await relay.tick())) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await Promise.all(Array.from({ length: relays }, () => run(new OutboxRelay(db, publisher, { batchSize: 25 }))));
  };
  const caughtUp = async (groupId: string) => {
    const [committed] = await admin.fetchOffsets({ groupId, topics: [topic] });
    const high = new Map((await admin.fetchTopicOffsets(topic)).map((p) => [p.partition, p.high]));
    return committed!.partitions.every((p) => p.offset === high.get(p.partition));
  };
  const steps = {
    consumer: ordering,
    topics: ['t4.step'],
    handler: async (event, tx) => {
      await tx.execute(sql`INSERT INTO t4_applied (aggregate_id, n) VALUES (${event.aggregateId}, ${Number(event.payload.n)})`);
    },
  } satisfies Subscription;

  beforeAll(async () => {
    t = await createTestDb({ poolMax: 8 });
    db = t.database.db;
    await db.execute(sql`CREATE TABLE t4_applied (aggregate_id text NOT NULL, n int NOT NULL, applied bigserial)`);
    admin = new Kafka({ clientId: 't4-admin', brokers, logLevel: logLevel.NOTHING }).admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 3 }], waitForLeaders: true });
    publisher = await bus();
  }, 120_000);
  afterAll(async () => {
    for (const b of buses) await b.close().catch(() => undefined);
    await admin?.deleteTopics({ topics: [topic] }).catch(() => undefined);
    await admin?.disconnect();
    await t?.cleanup();
  });

  it('applies every key in order while two consumers share three partitions', { timeout: 240_000 }, async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `order-${i}`);
    // Concurrent writers, three events of a key per transaction, published by two relays at once.
    await Promise.all(
      keys.map(async (key) => {
        for (let n = 1; n <= 15; n += 3) {
          await inTransaction(db, async (tx) => {
            for (let k = n; k < n + 3; k++) await appendEvent(tx, 't4.step', key, { n: k });
          });
        }
      }),
    );
    await relayAll(2);
    await bus(steps);
    await bus(steps);
    await until('180 steps applied', async () => (await count(db, sql`SELECT count(*)::int AS n FROM t4_applied`)) >= 180);
    for (const key of keys) {
      const order = await rows<{ n: number }>(db, sql`SELECT n FROM t4_applied WHERE aggregate_id = ${key} ORDER BY applied`);
      expect(order.map((r) => r.n), key).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    }
    expect((await admin.fetchTopicOffsets(topic)).filter((p) => Number(p.high) > 0)).toHaveLength(3);
  });

  it('replays the topic from the earliest offset without applying anything twice', { timeout: 240_000 }, async () => {
    while (buses.length > 1) await buses.pop()!.close();
    await until('ordering group caught up', () => caughtUp(ordering), 30_000);
    // Offsets can only be reset once every member has left the group.
    const empty = async () => (await admin.describeGroups([ordering])).groups[0]?.state === 'Empty';
    await until('ordering group empty', empty, 60_000);
    await admin.resetOffsets({ groupId: ordering, topic, earliest: true });
    expect(await caughtUp(ordering)).toBe(false);
    await bus(steps);
    await until('replay finished', () => caughtUp(ordering));
    expect(await count(db, sql`SELECT count(*)::int AS n FROM t4_applied`)).toBe(180);
    expect(await count(db, sql`SELECT count(*)::int AS n FROM processed_events WHERE consumer = ${ordering}`)).toBe(180);
  });

  it('rebuilds the search read model from scratch by consuming the topic from the beginning', { timeout: 240_000 }, async () => {
    const inventory = new InventoryService(db, systemClock);
    const catalog = new CatalogService(db, inventory);
    const ids = await inTransaction(db, (tx) => catalog.importSeed(tx, generateCatalog({ products: 30 }), new Map()));
    const productIds = [...ids.values()];
    // What admin edits would publish: every product, three stock-outs and one archived product.
    await inTransaction(db, async (tx) => {
      for (const id of productIds) await appendEvent(tx, 'catalog.product_upserted', id, { productId: id });
      for (const sku of ['THOCK-TK87-RED', 'THOCK-TK87-BROWN', 'THOCK-TK87-BLUE']) {
        await inventory.setStock(tx, (await catalog.findVariant(sku, tx))!.variantId, 0);
      }
      await tx.execute(sql`UPDATE products SET status = 'archived' WHERE id = ${productIds[5]!}`);
      await appendEvent(tx, 'catalog.product_upserted', productIds[5]!, { productId: productIds[5]! });
    });
    await relayAll(1);
    const embeddings = new HashEmbeddings();
    const indexer = new SearchIndexer(new PgSearchAdapter(db, embeddings), embeddings, catalog);
    const project = async (consumer: string) => {
      const b = await bus({ ...indexer.subscription(), consumer });
      const processed = sql`SELECT count(*)::int AS n FROM processed_events WHERE consumer = ${consumer}`;
      await until(`${consumer} consumed every catalog event`, async () => (await count(db, processed)) >= 34);
      await b.close();
      return rows<Record<string, unknown>>(
        db,
        sql`SELECT product_id, slug, name, brand, category_path::text, sku_text, band, min_price_paise, max_price_paise, in_stock,
                   embedding::text FROM search_documents ORDER BY product_id`,
      );
    };
    const original = await project(`t4-search-live-${suffix()}`);
    expect(original).toHaveLength(29);
    expect(original.find((d) => d.slug === 'thock-tk87-mechanical-keyboard')?.in_stock).toBe(false);

    await db.execute(sql`TRUNCATE search_documents`);
    expect(await project(`t4-search-rebuild-${suffix()}`)).toEqual(original);
  });
});
