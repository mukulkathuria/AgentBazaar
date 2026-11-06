import { Controller, Get, Inject, Param } from '@nestjs/common';
import { Routes } from '@agentbazaar/contracts';
import { Auth } from '../../../shared/http/auth.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { RecommendationsService } from '../application/recommendations.service.js';

@Controller()
export class RecommendationsController {
  constructor(@Inject(RecommendationsService) private readonly recs: RecommendationsService) {}

  @Get('api/v1/products/:slug/recommendations')
  @Auth('public')
  recommendations(@Param(new ZodPipe(Routes.recommendations.params)) p: { slug: string }) {
    return this.recs.recommendations(p.slug);
  }

  @Get('api/v1/products/:slug/compatible')
  @Auth('public')
  compatible(@Param(new ZodPipe(Routes.compatibleItems.params)) p: { slug: string }) {
    return this.recs.compatible(p.slug);
  }
}
