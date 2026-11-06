import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type { Executor } from '../../shared/db/database.js';
import { CONFIG, EVENT_BUS, READ_DB } from '../../shared/kernel/tokens.js';
import type { EventBus } from '../../shared/outbox/outbox.js';
import { AnalyticsService } from './application/analytics.service.js';
import { ANALYTICS_STORE, type AnalyticsStore } from './application/ports.js';
import { ClickHouseHttp } from './infrastructure/clickhouse.js';
import { ClickHouseAnalyticsStore } from './infrastructure/clickhouse-analytics.store.js';
import { PgAnalyticsStore } from './infrastructure/pg-analytics.store.js';
import { AnalyticsController } from './interfaces/analytics.controller.js';

/** loadConfig has already checked that CLICKHOUSE_URL is set when ClickHouse is selected. */
function createAnalyticsStore(config: AppConfig, reads: Executor): AnalyticsStore {
  if (config.adapters.analytics !== 'clickhouse') return new PgAnalyticsStore(reads);
  return new ClickHouseAnalyticsStore(new ClickHouseHttp(config.env.CLICKHOUSE_URL!));
}

@Module({
  controllers: [AnalyticsController],
  providers: [{ provide: ANALYTICS_STORE, inject: [CONFIG, READ_DB], useFactory: createAnalyticsStore }, AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(ANALYTICS_STORE) private readonly store: AnalyticsStore,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this.analytics.negotiationSubscription());
    const sink = this.store.subscription?.();
    if (sink) this.bus.subscribe(sink);
  }
}
