import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  CartLineInput,
  CompleteCheckoutInput,
  ReturnRequestInput,
  Routes,
  ShipOrderInput,
  StartCheckoutInput,
} from '@agentbazaar/contracts';
import type { FastifyReply } from 'fastify';
import type { Executor } from '../../../shared/db/database.js';
import { Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { withIdempotencyKey } from '../../../shared/http/idempotency.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { DB } from '../../../shared/kernel/tokens.js';
import { CartService } from '../application/cart.service.js';
import { CheckoutCompletion } from '../application/checkout-completion.js';
import { CheckoutService } from '../application/checkout.service.js';
import { OrdersService } from '../application/orders.service.js';

type Id = { id: string };
type LineParams = { id: string; lineId: string };
type Token = { t: string };
type OptionalToken = { t?: string | undefined };

@Controller()
export class OrdersController {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CartService) private readonly carts: CartService,
    @Inject(CheckoutService) private readonly checkout: CheckoutService,
    @Inject(CheckoutCompletion) private readonly completion: CheckoutCompletion,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  @Post('api/v1/carts')
  @Auth('optional')
  createCart(@CurrentPrincipal() who: Principal) {
    return this.carts.create(who.subject);
  }

  @Get('api/v1/carts/:id')
  @Auth('optional')
  getCart(@Param(new ZodPipe(Routes.getCart.params)) p: Id) {
    return this.carts.get(p.id);
  }

  @Post('api/v1/carts/:id/lines')
  @HttpCode(200)
  @Auth('optional')
  addLine(
    @Param(new ZodPipe(Routes.addCartLine.params)) p: Id,
    @Body(new ZodPipe(CartLineInput)) body: CartLineInput,
  ) {
    return this.carts.addLine(p.id, body);
  }

  @Patch('api/v1/carts/:id/lines/:lineId')
  @Auth('optional')
  updateLine(
    @Param(new ZodPipe(Routes.updateCartLine.params)) p: LineParams,
    @Body(new ZodPipe(Routes.updateCartLine.body)) body: { quantity: number },
  ) {
    return this.carts.updateLine(p.id, p.lineId, body.quantity);
  }

  @Delete('api/v1/carts/:id/lines/:lineId')
  @Auth('optional')
  removeLine(@Param(new ZodPipe(Routes.removeCartLine.params)) p: LineParams) {
    return this.carts.removeLine(p.id, p.lineId);
  }

  @Post('api/v1/checkout/sessions')
  @Auth('optional')
  async startCheckout(
    @Body(new ZodPipe(StartCheckoutInput)) body: StartCheckoutInput,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPrincipal() who: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await withIdempotencyKey(this.db, `checkout.start:${who.subject}`, key, body, async () => ({
      status: 201,
      body:
        'cartId' in body
          ? await this.checkout.startFromCart(who.subject, body.cartId)
          : await this.checkout.startFromQuote(who.subject, body.quoteToken),
    }));
    void reply.status(r.status);
    return r.body;
  }

  @Get('api/v1/checkout/sessions/:id')
  @Auth('optional')
  getCheckout(
    @Param(new ZodPipe(Routes.getCheckout.params)) p: Id,
    @Query(new ZodPipe(Routes.getCheckout.query)) q: Token,
  ) {
    return this.checkout.get(p.id, q.t);
  }

  @Post('api/v1/checkout/sessions/:id/link')
  @HttpCode(200)
  @Auth('optional')
  checkoutLink(
    @Param(new ZodPipe(Routes.checkoutLink.params)) p: Id,
    @Query(new ZodPipe(Routes.checkoutLink.query)) q: Token,
  ) {
    return this.checkout.linkFor(p.id, q.t);
  }

  @Post('api/v1/checkout/sessions/:id/complete')
  @Auth('optional')
  async completeCheckout(
    @Param(new ZodPipe(Routes.completeCheckout.params)) p: Id,
    @Query(new ZodPipe(Routes.completeCheckout.query)) q: Token,
    @Body(new ZodPipe(CompleteCheckoutInput)) body: CompleteCheckoutInput,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPrincipal() who: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await withIdempotencyKey(
      this.db,
      `checkout.complete:${who.subject}`,
      key,
      { sessionId: p.id, body },
      async () => ({
        status: 201,
        body: await this.completion.complete(p.id, q.t, body),
      }),
    );
    void reply.status(r.status);
    return r.body;
  }

  @Get('api/v1/orders/:id')
  @Auth('optional')
  getOrder(
    @Param(new ZodPipe(Routes.getOrder.params)) p: Id,
    @Query(new ZodPipe(Routes.getOrder.query)) q: OptionalToken,
    @CurrentPrincipal() who: Principal,
  ) {
    return this.orders.getForCaller(who, p.id, q.t);
  }

  @Get('api/v1/me/orders')
  @Auth('customer')
  myOrders(
    @Query(new ZodPipe(Routes.myOrders.query)) q: { limit: number; offset: number },
    @CurrentPrincipal() who: Principal,
  ) {
    return this.orders.listForCustomer(who, q.limit, q.offset);
  }

  @Post('api/v1/orders/:id/cancel')
  @HttpCode(200)
  @Auth('optional')
  cancel(
    @Param(new ZodPipe(Routes.cancelOrder.params)) p: Id,
    @Query(new ZodPipe(Routes.cancelOrder.query)) q: OptionalToken,
    @CurrentPrincipal() who: Principal,
  ) {
    return this.orders.cancel(who, p.id, q.t);
  }

  @Post('api/v1/orders/:id/returns')
  @HttpCode(200)
  @Auth('optional')
  requestReturn(
    @Param(new ZodPipe(Routes.requestReturn.params)) p: Id,
    @Query(new ZodPipe(Routes.requestReturn.query)) q: OptionalToken,
    @Body(new ZodPipe(ReturnRequestInput)) body: ReturnRequestInput,
    @CurrentPrincipal() who: Principal,
  ) {
    return this.orders.requestReturn(who, p.id, q.t, body);
  }

  @Post('api/v1/admin/orders/:id/ship')
  @HttpCode(200)
  @Auth('admin')
  ship(
    @Param(new ZodPipe(Routes.adminShipOrder.params)) p: Id,
    @Body(new ZodPipe(ShipOrderInput)) body: { trackingNumber: string },
    @CurrentPrincipal() who: Principal,
  ) {
    return this.orders.ship(p.id, body.trackingNumber, who.subject);
  }

  @Post('api/v1/admin/orders/:id/deliver')
  @HttpCode(200)
  @Auth('admin')
  deliver(@Param(new ZodPipe(Routes.adminDeliverOrder.params)) p: Id, @CurrentPrincipal() who: Principal) {
    return this.orders.deliver(p.id, who.subject);
  }

  @Post('api/v1/admin/orders/:id/returns/complete')
  @HttpCode(200)
  @Auth('admin')
  completeReturn(
    @Param(new ZodPipe(Routes.adminCompleteReturn.params)) p: Id,
    @CurrentPrincipal() who: Principal,
  ) {
    return this.orders.completeReturn(p.id, who.subject);
  }
}
