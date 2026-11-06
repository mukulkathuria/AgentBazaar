import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Scheduler } from '../../shared/jobs/scheduler.js';
import { EVENT_BUS, SCHEDULER } from '../../shared/kernel/tokens.js';
import type { EventBus } from '../../shared/outbox/outbox.js';
import { CatalogModule } from '../catalog/index.js';
import { CustomizationModule } from '../customization/index.js';
import { InventoryModule } from '../inventory/index.js';
import { PaymentsModule } from '../payments/index.js';
import { PiiModule } from '../pii/index.js';
import { PricingModule } from '../pricing/index.js';
import { TaxModule } from '../tax/index.js';
import { CartService } from './application/cart.service.js';
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
  ],
  controllers: [OrdersController],
  providers: [CartService, CheckoutService, OrdersService, OrderPlacement, OrderLifecycle],
  exports: [CartService, CheckoutService, OrdersService],
})
export class OrdersModule implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(SCHEDULER) private readonly scheduler: Scheduler,
    @Inject(CheckoutService) private readonly checkout: CheckoutService,
    @Inject(OrderLifecycle) private readonly lifecycle: OrderLifecycle,
  ) {}

  onModuleInit(): void {
    for (const sub of this.lifecycle.subscriptions()) this.bus.subscribe(sub);
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
}
