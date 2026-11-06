import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS } from '../../shared/kernel/tokens.js';
import type { EventBus } from '../../shared/outbox/outbox.js';
import { AnalyticsService } from './application/analytics.service.js';
import { AnalyticsController } from './interfaces/analytics.controller.js';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this.analytics.negotiationSubscription());
  }
}
