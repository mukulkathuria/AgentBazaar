import type { AppConfig } from '@agentbazaar/config';
import type { Logger } from 'pino';
import type { Executor } from '../db/database.js';
import { matchesTopic, runIdempotent, type EventBus, type OutboxEvent, type Subscription } from './outbox.js';

/** Wire format shared by every broker adapter. */
export interface WireEvent {
  id: string;
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const encodeEvent = (e: OutboxEvent): string =>
  JSON.stringify({ id: e.id, topic: e.topic, aggregateId: e.aggregateId, payload: e.payload, createdAt: e.createdAt.toISOString() } satisfies WireEvent);

export function decodeEvent(raw: string): OutboxEvent {
  const w = JSON.parse(raw) as Partial<WireEvent>;
  if (typeof w.id !== 'string' || typeof w.topic !== 'string' || typeof w.aggregateId !== 'string') {
    throw new Error('Malformed event on the bus');
  }
  return { id: w.id, topic: w.topic, aggregateId: w.aggregateId, payload: w.payload ?? {}, createdAt: new Date(w.createdAt ?? Date.now()) };
}

/** Handles one delivered message: skip if not subscribed, otherwise run the consumer exactly once. */
export async function deliver(db: Executor, sub: Subscription, raw: string): Promise<'skipped' | 'processed' | 'duplicate'> {
  const event = decodeEvent(raw);
  if (!matchesTopic(sub.topics, event.topic)) return 'skipped';
  return (await runIdempotent(db, sub.consumer, event, sub.handler)) ? 'processed' : 'duplicate';
}

/**
 * NATS JetStream (growth). Publishes with msgID for broker-side dedupe; durable pull consumers ack after commit.
 * Events go to `<stream in lower case>.<topic>` subjects; tests pass their own stream.
 */
export async function createNatsBus(url: string, db: Executor, logger: Logger, stream = 'AGENTBAZAAR'): Promise<EventBus> {
  const { AckPolicy, connect, StringCodec } = await import('nats');
  const nc = await connect({ servers: url, name: 'agentbazaar-api' });
  const jsm = await nc.jetstreamManager();
  const prefix = `${stream.toLowerCase()}.`;
  try {
    await jsm.streams.info(stream);
  } catch {
    await jsm.streams.add({ name: stream, subjects: [`${prefix}>`], duplicate_window: 120_000_000_000 });
  }
  const js = nc.jetstream();
  const sc = StringCodec();
  const stopped: (() => void)[] = [];
  return {
    subscribe(sub: Subscription) {
      void (async () => {
        await jsm.consumers.add(stream, { durable_name: sub.consumer, ack_policy: AckPolicy.Explicit, max_deliver: -1 });
        const consumer = await js.consumers.get(stream, sub.consumer);
        const messages = await consumer.consume();
        stopped.push(() => void messages.close());
        for await (const m of messages) {
          try {
            await deliver(db, sub, sc.decode(m.data));
            m.ack();
          } catch (err) {
            logger.warn({ err, consumer: sub.consumer }, 'nats delivery failed; will redeliver');
            m.nak(5_000);
          }
        }
      })().catch((err: unknown) => logger.error({ err, consumer: sub.consumer }, 'nats consumer stopped'));
    },
    async publish(events: OutboxEvent[]) {
      for (const e of events) await js.publish(`${prefix}${e.topic}`, sc.encode(encodeEvent(e)), { msgID: e.id });
    },
    async close() {
      for (const stop of stopped) stop();
      await nc.drain();
    },
  };
}

/** Apache Kafka (scale). One topic keyed by aggregate id keeps per-aggregate ordering; tests pass their own topic. */
export async function createKafkaBus(
  brokers: string[],
  db: Executor,
  logger: Logger,
  topic = 'agentbazaar.events',
): Promise<EventBus> {
  const { Kafka, logLevel } = await import('kafkajs');
  const kafka = new Kafka({ clientId: 'agentbazaar-api', brokers, logLevel: logLevel.WARN });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  const consumers: { disconnect(): Promise<void> }[] = [];
  return {
    subscribe(sub: Subscription) {
      const consumer = kafka.consumer({ groupId: sub.consumer });
      consumers.push(consumer);
      void (async () => {
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: true });
        await consumer.run({
          // Throwing makes kafkajs retry the message; the offset is committed only after success.
          eachMessage: async ({ message }) => {
            if (message.value) await deliver(db, sub, message.value.toString('utf8'));
          },
        });
      })().catch((err: unknown) => logger.error({ err, consumer: sub.consumer }, 'kafka consumer stopped'));
    },
    async publish(events: OutboxEvent[]) {
      await producer.send({
        topic,
        messages: events.map((e) => ({ key: e.aggregateId, value: encodeEvent(e), headers: { topic: e.topic, id: e.id } })),
      });
    },
    async close() {
      await Promise.all(consumers.map((c) => c.disconnect()));
      await producer.disconnect();
    },
  };
}

export async function createBrokerBus(config: AppConfig, db: Executor, logger: Logger): Promise<EventBus> {
  if (config.adapters.eventBus === 'nats') return createNatsBus(config.env.NATS_URL!, db, logger);
  if (config.adapters.eventBus === 'kafka') return createKafkaBus(config.env.KAFKA_BROKERS!, db, logger);
  throw new Error(`No broker for event bus "${config.adapters.eventBus}"`);
}
