import { Inject, Injectable } from '@nestjs/common';
import type { Part } from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import { type A2AInbound, rupeesToPaise } from '@agentbazaar/contracts';
import type { Logger } from 'pino';
import { assertRequirement, type Principal } from '../../../shared/http/auth.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { LOGGER } from '../../../shared/kernel/tokens.js';
import { checkoutReady } from '../domain/replies.js';
import { agentMessage, dataPart, errorParts, PRINCIPAL_STATE, readInbound, textPart } from './a2a-messages.js';
import { ChatService } from './chat.service.js';
import { Commerce } from './commerce.js';
import { isUnexpected, toA2ACheckout, toA2AQuote } from './views.js';

/**
 * A2A executor: structured parts drive the same negotiation state machine as MCP, free text goes
 * through the chat orchestrator. Every reply is one Message with a DataPart and a TextPart.
 */
@Injectable()
export class SellerAgentExecutor implements AgentExecutor {
  constructor(
    @Inject(Commerce) private readonly shop: Commerce,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const who = ctx.context.state.get(PRINCIPAL_STATE) as Principal | undefined;
    const parts = who ? await this.reply(who, ctx) : errorParts(new AppError('unauthorized', 'Not authenticated'));
    bus.publish(AgentEvent.message(agentMessage(ctx.contextId, parts)));
    bus.finished();
  }

  /** Every reply is immediate, so there is never a running task to cancel. */
  async cancelTask(_taskId: string, bus: ExecutionEventBus): Promise<void> {
    bus.finished();
  }

  private async reply(who: Principal, ctx: RequestContext): Promise<Part[]> {
    const inbound = readInbound(ctx.userMessage.parts);
    try {
      const first = inbound.data[0];
      if (first) return await this.structured(who, first);
      if (inbound.invalid.length) throw new AppError('validation_failed', `Unsupported data part: ${inbound.invalid.join(' | ')}`);
      if (inbound.text) return await this.conversation(who, ctx.contextId, inbound.text);
      throw new AppError('validation_failed', 'Send a text part, or a data part of type quote_request, offer or accept.');
    } catch (err) {
      if (isUnexpected(err)) this.logger.warn({ err }, 'A2A request failed');
      return errorParts(err);
    }
  }

  private async structured(who: Principal, m: A2AInbound): Promise<Part[]> {
    switch (m.type) {
      case 'quote_request': {
        assertRequirement(who, 'quote:create');
        const o = await this.shop.negotiations.requestQuote(who.subject, 'a2a', { sku: m.sku, quantity: m.quantity });
        return [dataPart(toA2AQuote(o, { sku: m.sku, quantity: m.quantity })), textPart(o.message)];
      }
      case 'offer': {
        assertRequirement(who, 'quote:create');
        const unitPaise = rupeesToPaise(m.unit_price.amount);
        const o = await this.shop.negotiations.makeOffer(who.subject, m.negotiation_id, { unitPricePaise: unitPaise, quantity: m.quantity });
        return [dataPart(toA2AQuote(o, { quantity: m.quantity, unitPaise })), textPart(o.message)];
      }
      case 'accept': {
        assertRequirement(who, 'order:create');
        const link = await this.shop.checkoutLink(who.subject, m.quote_token);
        return [dataPart(toA2ACheckout(link)), textPart(checkoutReady(link, 'en'))];
      }
    }
  }

  private async conversation(who: Principal, contextId: string, text: string): Promise<Part[]> {
    assertRequirement(who, 'catalog:read');
    const { reply, link } = await this.chat.converse(who, contextId, text);
    if (link) return [dataPart(toA2ACheckout(link)), textPart(reply.message)];
    if (reply.negotiation) return [dataPart(toA2AQuote(reply.negotiation)), textPart(reply.message)];
    return [dataPart({ type: 'chat', intent: reply.intent, handoff: reply.handoff }), textPart(reply.message)];
  }
}
