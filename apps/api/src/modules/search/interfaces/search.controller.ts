import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Routes, type SearchQuery } from '@agentbazaar/contracts';
import { Auth } from '../../../shared/http/auth.js';
import { ZodPipe } from '../../../shared/http/zod.js';
import { SearchService } from '../application/search.service.js';

@Controller()
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get('api/v1/products')
  @Auth('public')
  find(@Query(new ZodPipe(Routes.searchProducts.query)) q: SearchQuery) {
    return this.search.search(q);
  }
}
