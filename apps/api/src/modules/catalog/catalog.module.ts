import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/index.js';
import { CatalogService } from './application/catalog.service.js';
import { CatalogController } from './interfaces/catalog.controller.js';

@Module({
  imports: [InventoryModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
