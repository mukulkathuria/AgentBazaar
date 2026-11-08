import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/index.js';
import { DashboardController } from './interfaces/dashboard.controller.js';

/** Read-only admin views that span modules (the dashboard). Owns no tables. */
@Module({ imports: [AnalyticsModule], controllers: [DashboardController] })
export class AdminModule {}
