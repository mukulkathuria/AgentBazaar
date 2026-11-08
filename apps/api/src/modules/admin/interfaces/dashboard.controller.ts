import { Controller, Get, Inject } from '@nestjs/common';
import type { DashboardView } from '@agentbazaar/contracts';
import type { Executor } from '../../../shared/db/database.js';
import { Auth } from '../../../shared/http/auth.js';
import { READ_DB } from '../../../shared/kernel/tokens.js';
import { conversationStats, openHandoffs } from '../../agent/index.js';
import { AnalyticsService } from '../../analytics/index.js';
import { llmCallCount } from '../../audit/index.js';
import { pendingReviews } from '../../customization/index.js';
import { orderStats } from '../../orders/index.js';
import { negotiationStats, pendingApprovals } from '../../pricing/index.js';

@Controller()
export class DashboardController {
  constructor(
    /** Aggregates only: a replica in growth (ADR 0009). */
    @Inject(READ_DB) private readonly reads: Executor,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}

  /** Each number comes from the module that owns its table; windows are the last 30 days, queues are current. */
  @Get('api/v1/admin/dashboard')
  @Auth('admin')
  async dashboard(): Promise<DashboardView> {
    const [orders, negotiations, conversations, llmCalls, geo, approvals, reviews, handoffs] = await Promise.all([
      orderStats(this.reads),
      negotiationStats(this.reads),
      conversationStats(this.reads),
      llmCallCount(this.reads),
      this.analytics.dashboardGeo(),
      pendingApprovals(this.reads),
      pendingReviews(this.reads),
      openHandoffs(this.reads),
    ]);
    return { orders, negotiations, agents: { ...conversations, llmCalls }, geo, queues: { approvals, reviews, handoffs } };
  }
}
