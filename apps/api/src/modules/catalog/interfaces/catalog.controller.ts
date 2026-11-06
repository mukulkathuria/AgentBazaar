import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { AdminProductInput, Routes } from '@agentbazaar/contracts';
import { Auth, CurrentPrincipal, type Principal } from '../../../shared/http/auth.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { CatalogService } from '../application/catalog.service.js';

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('api/v1/products/:slug')
  @Auth('public')
  get(@Param(new ZodPipe(Routes.getProduct.params)) p: { slug: string }) {
    return this.catalog.getProduct(p.slug);
  }

  @Get('api/v1/categories')
  @Auth('public')
  categories() {
    return this.catalog.listCategories();
  }

  @Get('api/v1/availability/:sku')
  @Auth('public')
  availability(
    @Param(new ZodPipe(Routes.checkAvailability.params)) p: { sku: string },
    @Query(new ZodPipe(Routes.checkAvailability.query)) q: { quantity: number },
  ) {
    return this.catalog.availabilityFor(p.sku, q.quantity);
  }

  @Get('api/v1/feed/products')
  @Auth('public')
  feed(@Query(new ZodPipe(Routes.productFeed.query)) q: { limit: number; offset: number }) {
    return this.catalog.feed(q.limit, q.offset);
  }

  @Post('api/v1/admin/products')
  @Auth('admin')
  upsert(@Body(new ZodPipe(AdminProductInput)) body: AdminProductInput, @CurrentPrincipal() who: Principal) {
    return this.catalog.upsertProduct(body, who.subject);
  }
}
