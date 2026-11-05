import { Controller, Get, Inject, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { Executor } from '../db/database.js';
import { AppError } from '../kernel/errors.js';
import { DB, METRICS } from '../kernel/tokens.js';
import type { Metrics } from '../observability/metrics.js';
import { outboxLag } from '../outbox/outbox.js';
import { Auth } from './auth.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  @Get('healthz')
  @Auth('public')
  live() {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Auth('public')
  async ready() {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      throw new AppError('unavailable', 'Database is not reachable');
    }
    const outbox = await outboxLag(this.db);
    this.metrics.outboxPending.set(outbox.pending);
    return { status: 'ready', outbox };
  }

  /** Scrape endpoint. The edge (Caddy) must not expose it publicly. */
  @Get('metrics')
  @Auth('public')
  async scrape(@Res() reply: FastifyReply) {
    await reply.header('content-type', this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }
}
