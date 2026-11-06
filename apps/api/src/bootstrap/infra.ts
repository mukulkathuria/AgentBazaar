import type { AppConfig } from '@agentbazaar/config';
import { ALL_AGENT_SCOPES, type AgentScope } from '@agentbazaar/contracts';
import type { Logger } from 'pino';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryCache, type Cache } from '../shared/cache/cache.js';
import { loadKeyRing, type KeyRing } from '../shared/crypto/keyring.js';
import { createPgliteDatabase, createPostgresDatabase, type Database, type Executor } from '../shared/db/database.js';
import { loadMigrations, migrate } from '../shared/db/migrator.js';
import { createReplicaRouter, type ReplicaRouter } from '../shared/db/replicas.js';
import { Scheduler } from '../shared/jobs/scheduler.js';
import { systemClock, type Clock } from '../shared/kernel/clock.js';
import { createLogger } from '../shared/observability/logger.js';
import { createMetrics, type Metrics } from '../shared/observability/metrics.js';
import { InProcessEventBus, OutboxRelay, type EventBus } from '../shared/outbox/outbox.js';
import { partitionMaintenanceJob } from '../shared/partitions/partitions.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface Infra {
  readonly config: AppConfig;
  readonly database: Database;
  readonly db: Executor;
  /** `db` itself unless DATABASE_REPLICA_URLS is set; then reads routed by `replicas`. */
  readonly readDb: Executor;
  readonly replicas: ReplicaRouter | undefined;
  readonly clock: Clock;
  readonly keys: KeyRing;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly cache: Cache;
  readonly bus: EventBus;
  readonly relay: OutboxRelay;
  readonly scheduler: Scheduler;
  readonly anonymousScopes: readonly AgentScope[];
}

export interface InfraOverrides {
  database?: Database;
  clock?: Clock;
  logger?: Logger;
  cache?: Cache;
}

export async function createDatabase(config: AppConfig): Promise<Database> {
  const env = config.env;
  if (config.adapters.database === 'pglite') return createPgliteDatabase(env.PGLITE_DATA_DIR);
  return createPostgresDatabase({ url: env.DATABASE_URL!, poolMax: env.DATABASE_POOL_MAX });
}

async function createCache(config: AppConfig): Promise<Cache> {
  if (config.adapters.cache !== 'valkey') return new MemoryCache();
  // Loaded lazily: lite deployments never import the Valkey client.
  const { createValkeyCache } = await import('../shared/cache/valkey-cache.js');
  return createValkeyCache(config.env.VALKEY_URL!);
}

async function createBus(config: AppConfig, db: Executor, logger: Logger): Promise<EventBus> {
  if (config.adapters.eventBus === 'inprocess') return new InProcessEventBus(db);
  const { createBrokerBus } = await import('../shared/outbox/broker-bus.js');
  return createBrokerBus(config, db, logger);
}

/** Builds every adapter the selected profile needs. Fails fast on unreachable required services. */
export async function createInfra(config: AppConfig, overrides: InfraOverrides = {}): Promise<Infra> {
  const logger = overrides.logger ?? createLogger(config.env.LOG_LEVEL);
  for (const w of config.warnings) logger.warn(w);
  const keys = loadKeyRing(config.env);
  const database = overrides.database ?? (await createDatabase(config));
  if (!process.env.SKIP_MIGRATIONS) {
    const applied = await migrate(database, loadMigrations(MIGRATIONS_DIR));
    if (applied.length) logger.info({ applied }, 'migrations applied');
  }
  const db = database.db;
  const cache = overrides.cache ?? (await createCache(config));
  const metrics = createMetrics();
  const replicaUrls = config.env.DATABASE_REPLICA_URLS ?? [];
  const replicas =
    database.driver === 'postgres' && replicaUrls.length
      ? createReplicaRouter(database, replicaUrls, {
          cache,
          maxLagMs: config.env.DATABASE_REPLICA_MAX_LAG_MS,
          registry: metrics.registry,
          logger,
          poolMax: config.env.DATABASE_POOL_MAX,
        })
      : undefined;
  const bus = await createBus(config, db, logger);
  const relay = new OutboxRelay(db, bus, { onError: (err) => logger.warn({ err }, 'outbox delivery failed; will retry') });
  const scheduler = new Scheduler(db, logger);
  scheduler.register(partitionMaintenanceJob);
  return {
    config,
    database,
    db,
    readDb: replicas?.reads ?? db,
    replicas,
    clock: overrides.clock ?? systemClock,
    keys,
    logger,
    metrics,
    cache,
    bus,
    relay,
    scheduler,
    anonymousScopes: config.env.DEMO_MODE ? ALL_AGENT_SCOPES : ['catalog:read'],
  };
}
