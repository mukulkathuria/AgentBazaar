import { loadConfig } from '@agentbazaar/config';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { createApp, type RunningApp } from '../../src/bootstrap/create-app.js';
import type { Clock } from '../../src/shared/kernel/clock.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import { createTestDb } from './test-db.js';

export interface TestApp extends RunningApp {
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  /** Delivers all pending outbox events synchronously (no background relay in tests). */
  drain(): Promise<number>;
}

export async function createTestApp(env: Record<string, string> = {}, opts: { clock?: Clock } = {}): Promise<TestApp> {
  const testDb = await createTestDb();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_DRIVER: testDb.url ? 'postgres' : 'pglite',
    ...(testDb.url ? { DATABASE_URL: testDb.url } : {}),
    RATE_LIMIT_PER_MINUTE: '100000',
    PUBLIC_API_URL: 'http://api.test',
    PUBLIC_WEB_URL: 'http://web.test',
    ...env,
  });
  const running = await createApp(config, {
    database: testDb.database,
    background: false,
    logger: createLogger('silent'),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return {
    ...running,
    inject: (o) => running.app.inject(o),
    drain: () => running.infra.relay.drain(),
    async close() {
      await running.close();
      await testDb.cleanup();
    },
  };
}
