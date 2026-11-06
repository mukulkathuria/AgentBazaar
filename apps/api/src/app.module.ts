import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Infra } from './bootstrap/infra.js';
import { AgentModule } from './modules/agent/index.js';
import { AnalyticsModule } from './modules/analytics/index.js';
import { AuditModule } from './modules/audit/index.js';
import { CatalogModule } from './modules/catalog/index.js';
import { CustomizationModule } from './modules/customization/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { InventoryModule } from './modules/inventory/index.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { OrdersModule } from './modules/orders/index.js';
import { PaymentsModule } from './modules/payments/index.js';
import { PiiModule } from './modules/pii/index.js';
import { PricingModule } from './modules/pricing/index.js';
import { RecommendationsModule } from './modules/recommendations/index.js';
import { SearchModule } from './modules/search/index.js';
import { TaxModule } from './modules/tax/index.js';
import { AuthGuard } from './shared/http/auth.js';
import { HealthController } from './shared/http/health.controller.js';
import { InfraModule } from './shared/infra.module.js';

/** Composition root: wires infrastructure and every feature module. */
@Module({})
export class AppModule {
  static register(infra: Infra): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.register(infra),
        AuditModule,
        IdentityModule,
        CatalogModule,
        InventoryModule,
        CustomizationModule,
        PricingModule,
        TaxModule,
        PiiModule,
        PaymentsModule,
        OrdersModule,
        NotificationsModule,
        SearchModule,
        RecommendationsModule,
        AnalyticsModule,
        AgentModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
