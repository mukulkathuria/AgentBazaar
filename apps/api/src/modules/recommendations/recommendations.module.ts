import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Executor } from '../../shared/db/database.js';
import { DB, EVENT_BUS, LOGGER, READ_DB } from '../../shared/kernel/tokens.js';
import type { EventBus } from '../../shared/outbox/outbox.js';
import { CatalogModule } from '../catalog/index.js';
import { GRAPH_REPOSITORY } from './application/graph-repository.js';
import { RecommendationsService } from './application/recommendations.service.js';
import { createGraphRepository } from './infrastructure/pgq-graph.repository.js';
import { RecommendationsController } from './interfaces/recommendations.controller.js';

@Module({
  imports: [CatalogModule],
  controllers: [RecommendationsController],
  providers: [
    {
      provide: GRAPH_REPOSITORY,
      inject: [DB, LOGGER, READ_DB],
      useFactory: async (db: Executor, logger: Logger, reads: Executor) => {
        const repo = await createGraphRepository(db, reads);
        logger.info({ engine: repo.engine }, 'product graph ready');
        return repo;
      },
    },
    RecommendationsService,
  ],
  exports: [RecommendationsService],
})
export class RecommendationsModule implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(RecommendationsService) private readonly recs: RecommendationsService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this.recs.learnerSubscription());
  }
}
