import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from '@agentbazaar/config';
import { AppModule } from '../app.module.js';
import { safeEqual } from '../shared/crypto/primitives.js';
import { ErrorFilter, toErrorResponse } from '../shared/http/error.filter.js';
import { NestPinoLogger } from '../shared/observability/logger.js';
import { createInfra, type Infra, type InfraOverrides } from './infra.js';

export interface RunningApp {
  readonly app: NestFastifyApplication;
  readonly infra: Infra;
  close(): Promise<void>;
}

export interface CreateAppOptions extends InfraOverrides {
  /** Start the outbox relay and job scheduler. Tests drive them by hand instead. */
  background?: boolean;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function createApp(config: AppConfig, opts: CreateAppOptions = {}): Promise<RunningApp> {
  const infra = await createInfra(config, opts);
  const adapter = new FastifyAdapter({
    logger: false,
    trustProxy: true,
    bodyLimit: 256 * 1024,
    // Accept a caller's request id only if it is well-formed, so it cannot inject into logs.
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(infra), adapter, {
    logger: new NestPinoLogger(infra.logger),
    rawBody: true,
    abortOnError: false,
  });
  app.useGlobalFilters(new ErrorFilter(infra.logger));
  app.enableCors({ origin: [...config.corsOrigins], credentials: true, exposedHeaders: ['x-request-id', 'mcp-session-id'] });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.setErrorHandler((err, req, reply) => {
    const { status, body, internal } = toErrorResponse(err, req.id);
    if (internal) infra.logger.error({ err, reqId: req.id }, 'unhandled error');
    void reply.status(status).send(body);
  });
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], imgSrc: ["'self'", 'data:'] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  const ingestKey = config.env.ANALYTICS_INGEST_KEY;
  await app.register(rateLimit, {
    global: true,
    max: config.env.RATE_LIMIT_PER_MINUTE,
    timeWindow: 60_000,
    // The web server reports every crawler hit from one IP; its ingest key exempts it from the per-IP limit.
    allowList: (req) => {
      if (req.url === '/healthz' || req.url === '/readyz') return true;
      const key = req.headers['x-ingest-key'];
      return Boolean(ingestKey) && typeof key === 'string' && safeEqual(key, ingestKey!);
    },
  });
  fastify.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  const replicas = infra.replicas;
  if (replicas) {
    // Routed reads see the request they serve; a request's writes pin its principal's later reads (ADR 0009).
    fastify.addHook('preHandler', (req, _reply, done) => replicas.scope.run(req, done));
    fastify.addHook('onSend', async (req) => replicas.recordWrites(req));
  }
  fastify.addHook('onResponse', async (req, reply) => {
    // Route patterns only: raw URLs can carry checkout and order tokens in the query string.
    const route = req.routeOptions.url ?? 'unmatched';
    infra.metrics.httpDuration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) infra.logger.error({ reqId: req.id, method: req.method, route, status: reply.statusCode }, 'request failed');
  });

  await app.init();
  if (opts.background !== false) {
    infra.relay.start();
    infra.scheduler.start();
    replicas?.start();
  }
  let closed = false;
  return {
    app,
    infra,
    async close() {
      if (closed) return;
      closed = true;
      infra.scheduler.stop();
      await infra.relay.stop();
      await app.close();
      await infra.bus.close();
      await replicas?.close();
      await infra.cache.close();
      await infra.database.close();
    },
  };
}
