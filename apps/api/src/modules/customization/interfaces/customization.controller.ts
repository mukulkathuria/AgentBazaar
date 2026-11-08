import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { CustomizationValues, DecisionInput, Routes } from '@agentbazaar/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { CustomizationService } from '../application/customization.service.js';

const PreviewQuery = z.object({ d: z.string().max(4000) });

@Controller()
export class CustomizationController {
  constructor(@Inject(CustomizationService) private readonly customization: CustomizationService) {}

  @Get('api/v1/customization/:sku')
  @Auth('public')
  options(@Param(new ZodPipe(Routes.customizationOptions.params)) p: { sku: string }) {
    return this.customization.options(p.sku);
  }

  @Post('api/v1/customization/:sku/validate')
  @HttpCode(200)
  @Auth('public')
  validate(
    @Param(new ZodPipe(Routes.validateCustomization.params)) p: { sku: string },
    @Body(new ZodPipe(CustomizationValues)) body: CustomizationValues,
  ) {
    return this.customization.validate(p.sku, body);
  }

  @Get('api/v1/customization/:sku/preview.svg')
  @Auth('public')
  async preview(
    @Param(new ZodPipe(Routes.customizationOptions.params)) p: { sku: string },
    @Query(new ZodPipe(PreviewQuery)) q: { d: string },
    @Res() reply: FastifyReply,
  ) {
    const svg = await this.customization.previewSvg(p.sku, q.d);
    await reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'public, max-age=3600')
      .send(svg);
  }

  @Get('api/v1/admin/reviews')
  @Auth('admin')
  reviews() {
    return this.customization.listReviews();
  }

  @Post('api/v1/admin/reviews/:id/decide')
  @HttpCode(200)
  @Auth('admin')
  decide(
    @Param(new ZodPipe(Routes.adminDecideReview.params)) p: { id: string },
    @Body(new ZodPipe(DecisionInput)) body: { approve: boolean; note?: string },
    @CurrentPrincipal() who: Principal,
  ) {
    return this.customization.decideReview(p.id, body.approve, body.note, who.subject);
  }
}
