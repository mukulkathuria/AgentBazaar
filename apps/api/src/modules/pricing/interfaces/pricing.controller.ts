import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { DecisionInput, DiscountPolicyInput, RequestQuoteInput, Routes } from '@agentbazaar/contracts';
import { Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { NegotiationService } from '../application/negotiation.service.js';

@Controller()
export class PricingController {
  constructor(@Inject(NegotiationService) private readonly negotiations: NegotiationService) {}

  @Post('api/v1/quotes')
  @Auth('quote:create')
  quote(@Body(new ZodPipe(RequestQuoteInput)) body: RequestQuoteInput, @CurrentPrincipal() who: Principal) {
    return this.negotiations.requestQuote(who.subject, 'rest', body);
  }

  @Post('api/v1/negotiations/:id/offers')
  @HttpCode(200)
  @Auth('quote:create')
  offer(
    @Param(new ZodPipe(Routes.makeOffer.params)) p: { id: string },
    @Body(new ZodPipe(Routes.makeOffer.body)) body: { unitPricePaise: number; quantity?: number; message?: string },
    @CurrentPrincipal() who: Principal,
  ) {
    return this.negotiations.makeOffer(who.subject, p.id, body);
  }

  @Get('api/v1/admin/approvals')
  @Auth('admin')
  approvals() {
    return this.negotiations.listApprovals();
  }

  @Post('api/v1/admin/approvals/:id/decide')
  @HttpCode(200)
  @Auth('admin')
  decide(
    @Param(new ZodPipe(Routes.adminDecideApproval.params)) p: { id: string },
    @Body(new ZodPipe(DecisionInput)) body: { approve: boolean; note?: string },
    @CurrentPrincipal() who: Principal,
  ) {
    return this.negotiations.decideApproval(p.id, body.approve, body.note, who.subject);
  }

  @Get('api/v1/admin/negotiations')
  @Auth('admin')
  list(@Query(new ZodPipe(Routes.adminNegotiations.query)) q: { limit: number; offset: number }) {
    return this.negotiations.listForAdmin(q.limit, q.offset);
  }

  @Get('api/v1/admin/policies')
  @Auth('admin')
  policies() {
    return this.negotiations.listPolicies();
  }

  @Put('api/v1/admin/policies')
  @Auth('admin')
  updatePolicy(@Body(new ZodPipe(DiscountPolicyInput)) body: DiscountPolicyInput, @CurrentPrincipal() who: Principal) {
    return this.negotiations.updatePolicy(body, who.subject);
  }
}
