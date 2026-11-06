import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import type { Scheduler } from '../../shared/jobs/scheduler.js';
import { SCHEDULER } from '../../shared/kernel/tokens.js';
import { InventoryService } from './application/inventory.service.js';

@Module({ providers: [InventoryService], exports: [InventoryService] })
export class InventoryModule implements OnModuleInit {
  constructor(
    @Inject(SCHEDULER) private readonly scheduler: Scheduler,
    @Inject(InventoryService) private readonly inventory: InventoryService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({ name: 'inventory.expire-reservations', everyMs: 30_000, run: (tx) => this.inventory.sweepExpired(tx) });
  }
}
