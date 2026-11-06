import { Module } from '@nestjs/common';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import type { AppConfig } from '@agentbazaar/config';
import { CONFIG, LOGGER } from '../../shared/kernel/tokens.js';
import { CatalogModule } from '../catalog/index.js';
import { CustomizationModule } from '../customization/index.js';
import { OrdersModule } from '../orders/index.js';
import { PricingModule } from '../pricing/index.js';
import { RecommendationsModule } from '../recommendations/index.js';
import { SearchModule } from '../search/index.js';
import { agentCard } from './application/a2a-messages.js';
import { SellerAgentExecutor } from './application/a2a-executor.js';
import { ChatStore } from './application/chat-store.js';
import { ChatService } from './application/chat.service.js';
import { Commerce } from './application/commerce.js';
import { McpTools } from './application/mcp-tools.js';
import { Phraser } from './application/phraser.js';
import { DEFAULT_PRICES } from './domain/budget.js';
import { CLASSIFIER, LLM, LLM_PRICES } from './domain/ports.js';
import { createClassifier, createLlm } from './infrastructure/factories.js';
import { A2A_HANDLER, A2aController } from './interfaces/a2a.controller.js';
import { ChatController } from './interfaces/chat.controller.js';
import { McpController } from './interfaces/mcp.controller.js';

/** Agent layer: chat orchestrator, MCP server and A2A endpoint. Needs AuditModule (global) in the app. */
@Module({
  imports: [CatalogModule, CustomizationModule, PricingModule, SearchModule, RecommendationsModule, OrdersModule],
  controllers: [ChatController, McpController, A2aController],
  providers: [
    { provide: LLM, inject: [CONFIG, LOGGER], useFactory: createLlm },
    { provide: CLASSIFIER, inject: [CONFIG, LOGGER], useFactory: createClassifier },
    { provide: LLM_PRICES, useValue: DEFAULT_PRICES },
    Commerce,
    ChatStore,
    Phraser,
    ChatService,
    McpTools,
    SellerAgentExecutor,
    {
      provide: A2A_HANDLER,
      inject: [CONFIG, SellerAgentExecutor],
      useFactory: (config: AppConfig, executor: SellerAgentExecutor) => new DefaultRequestHandler(agentCard(config), new InMemoryTaskStore(), executor),
    },
  ],
  exports: [ChatService],
})
export class AgentModule {}
