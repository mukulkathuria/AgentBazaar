import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import type { Scheduler } from '../../shared/jobs/scheduler.js';
import { CONFIG, EVENT_BUS, SCHEDULER } from '../../shared/kernel/tokens.js';
import type { EventBus } from '../../shared/outbox/outbox.js';
import { CatalogModule } from '../catalog/index.js';
import { CustomizationModule } from '../customization/index.js';
import { InventoryModule } from '../inventory/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { PaymentsModule } from '../payments/index.js';
import { PiiModule } from '../pii/index.js';
import { PricingModule } from '../pricing/index.js';
import { TaxModule } from '../tax/index.js';
import { CartService } from './application/cart.service.js';
import { WORKFLOW_ENGINE, type WorkflowEngine } from './application/checkout-saga.js';
import { CheckoutCompletion } from './application/checkout-completion.js';
import { CheckoutSagaSteps } from './application/checkout-saga-steps.js';
import { CheckoutService } from './application/checkout.service.js';
import { OrderLifecycle } from './application/order-lifecycle.service.js';
import { OrderPlacement } from './application/order-placement.js';
import { OrdersService } from './application/orders.service.js';
import { OrdersController } from './interfaces/orders.controller.js';

@Module({
  imports: [
    CatalogModule,
    CustomizationModule,
    InventoryModule,
    PricingModule,
    TaxModule,
    PiiModule,
    PaymentsModule,
    NotificationsModule,
  ],
  controllers: [OrdersController],
  providers: [
    CartService,
    CheckoutService,
    CheckoutCompletion,
    OrdersService,
    OrderPlacement,
    OrderLifecycle,
    CheckoutSagaSteps,
    {
      provide: WORKFLOW_ENGINE,
      inject: [CONFIG],
      useFactory: async (config: AppConfig): Promise<WorkflowEngine | null> => {
        if (config.env.WORKFLOW_ENGINE !== 'temporal') return null;
        // Loaded lazily: with the in-process engine the Temporal client is never imported.
        const { connectTemporalEngine } = await import('./infrastructure/temporal/engine.js');
        return connectTemporalEngine(config.env);
      },
    },
  ],
  exports: [CartService, CheckoutService, OrdersService, CheckoutSagaSteps],
})
export class OrdersModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(SCHEDULER) private readonly scheduler: Scheduler,
    @Inject(CheckoutService) private readonly checkout: CheckoutService,
    @Inject(OrderLifecycle) private readonly lifecycle: OrderLifecycle,
    @Inject(WORKFLOW_ENGINE) private readonly saga: WorkflowEngine | null,
  ) {}

  onModuleInit(): void {
    for (const sub of this.lifecycle.subscriptions(this.saga)) this.bus.subscribe(sub);
    this.scheduler.register({
      name: 'orders.expire-checkouts',
      everyMs: 30_000,
      run: (tx) => this.checkout.expireSessions(tx),
    });
    this.scheduler.register({
      name: 'orders.expire-unpaid',
      everyMs: 60_000,
      run: (tx) => this.lifecycle.expireUnpaid(tx),
    });
    this.scheduler.register({
      name: 'orders.cancel-unreconciled',
      everyMs: 3_600_000,
      run: (tx) => this.lifecycle.cancelUnreconciled(tx),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.saga?.close();
  }
}
