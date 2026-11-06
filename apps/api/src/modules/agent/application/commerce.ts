import { Inject, Injectable } from '@nestjs/common';
import type { CheckoutLink } from '@agentbazaar/contracts';
import { CatalogService } from '../../catalog/index.js';
import { CustomizationService } from '../../customization/index.js';
import { CheckoutService, OrdersService } from '../../orders/index.js';
import { NegotiationService } from '../../pricing/index.js';
import { RecommendationsService } from '../../recommendations/index.js';
import { SearchService } from '../../search/index.js';

/**
 * The agent layer's only way into the store. Every number an agent or chat reply shows comes from
 * one of these services; the agent layer never computes a price itself.
 */
@Injectable()
export class Commerce {
  constructor(
    @Inject(CatalogService) readonly catalog: CatalogService,
    @Inject(SearchService) readonly search: SearchService,
    @Inject(RecommendationsService) readonly recommendations: RecommendationsService,
    @Inject(CustomizationService) readonly customization: CustomizationService,
    @Inject(NegotiationService) readonly negotiations: NegotiationService,
    @Inject(CheckoutService) readonly checkout: CheckoutService,
    @Inject(OrdersService) readonly orders: OrdersService,
  ) {}

  /** The buyer accepted: the quote becomes a checkout session and a signed link a person opens to pay. */
  async checkoutLink(subject: string, quoteToken: string): Promise<CheckoutLink> {
    const session = await this.checkout.startFromQuote(subject, quoteToken);
    if (!session.token) throw new Error('Checkout session was created without a capability token');
    return this.checkout.linkFor(session.sessionId, session.token);
  }
}
