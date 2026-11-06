import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Scheduler } from '../../shared/jobs/scheduler.js';
import { SCHEDULER } from '../../shared/kernel/tokens.js';
import { CatalogModule } from '../catalog/index.js';
import { CustomizationModule } from '../customization/index.js';
import { InventoryModule } from '../inventory/index.js';
import { NegotiationService } from './application/negotiation.service.js';
import { PricingController } from './interfaces/pricing.controller.js';

@Module({
  imports: [CatalogModule, CustomizationModule, InventoryModule],
  controllers: [PricingController],
  providers: [NegotiationService],
  exports: [NegotiationService],
})
export class PricingModule implements OnModuleInit {
  constructor(
    @Inject(SCHEDULER) private readonly scheduler: Scheduler,
    @Inject(NegotiationService) private readonly negotiations: NegotiationService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({ name: 'pricing.expire-negotiations', everyMs: 30_000, run: (tx) => this.negotiations.sweepExpired(tx) });
  }
}
