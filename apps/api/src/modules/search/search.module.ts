import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type { Logger } from 'pino';
import type { Executor } from '../../shared/db/database.js';
import { CONFIG, DB, EVENT_BUS, LOGGER } from '../../shared/kernel/tokens.js';
import type { EventBus } from '../../shared/outbox/outbox.js';
import { AnalyticsModule } from '../analytics/index.js';
import { CatalogModule } from '../catalog/index.js';
import { EMBEDDINGS, SEARCH_PORT, type SearchPort } from './application/ports.js';
import { SearchIndexer } from './application/search-indexer.js';
import { SearchService } from './application/search.service.js';
import { HashEmbeddings, type EmbeddingsPort } from './domain/embeddings.js';
import { AiServiceEmbeddings } from './infrastructure/ai-service-embeddings.js';
import { MeilisearchAdapter } from './infrastructure/meilisearch.adapter.js';
import { OpenSearchAdapter } from './infrastructure/opensearch.adapter.js';
import { PgSearchAdapter } from './infrastructure/pg-search.adapter.js';
import { SearchController } from './interfaces/search.controller.js';

function createEmbeddings(config: AppConfig, logger: Logger): EmbeddingsPort {
  if (config.adapters.embeddings !== 'ai-service') return new HashEmbeddings();
  const token = config.env.AI_SERVICE_TOKEN;
  return new AiServiceEmbeddings(config.env.AI_SERVICE_URL!, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    onFallback: (err) => logger.warn({ err }, 'ai-service embeddings failed; using hash embeddings'),
  });
}

/** loadConfig has already checked that the selected engine's URLs are set. */
function createSearchPort(config: AppConfig, db: Executor, embeddings: EmbeddingsPort): SearchPort {
  const env = config.env;
  switch (config.adapters.search) {
    case 'meilisearch':
      return new MeilisearchAdapter({ url: env.MEILISEARCH_URL!, apiKey: env.MEILISEARCH_API_KEY }, embeddings);
    case 'opensearch':
      return new OpenSearchAdapter({ url: env.OPENSEARCH_URL!, qdrantUrl: env.QDRANT_URL! }, embeddings);
    default:
      return new PgSearchAdapter(db, embeddings);
  }
}

@Module({
  imports: [CatalogModule, AnalyticsModule],
  controllers: [SearchController],
  providers: [
    { provide: EMBEDDINGS, inject: [CONFIG, LOGGER], useFactory: createEmbeddings },
    { provide: SEARCH_PORT, inject: [CONFIG, DB, EMBEDDINGS], useFactory: createSearchPort },
    SearchService,
    SearchIndexer,
  ],
  exports: [SearchService, SearchIndexer, SEARCH_PORT, EMBEDDINGS],
})
export class SearchModule implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(SearchIndexer) private readonly indexer: SearchIndexer,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this.indexer.subscription());
  }
}
