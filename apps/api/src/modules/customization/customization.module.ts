import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/index.js';
import { CustomizationService } from './application/customization.service.js';
import { CustomizationController } from './interfaces/customization.controller.js';

@Module({
  imports: [CatalogModule],
  controllers: [CustomizationController],
  providers: [CustomizationService],
  exports: [CustomizationService],
})
export class CustomizationModule {}
