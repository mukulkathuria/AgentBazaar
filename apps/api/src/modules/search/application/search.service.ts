import { Inject, Injectable } from '@nestjs/common';
import { SearchQuery, type SearchResult } from '@agentbazaar/contracts';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Executor } from '../../../shared/db/database.js';
import { parseOrThrow } from '../../../shared/http/zod.js';
import { DB, LOGGER } from '../../../shared/kernel/tokens.js';
import { AnalyticsService } from '../../analytics/index.js';
import { translateHindi } from '../domain/hindi-terms.js';
import { SEARCH_PORT, type SearchPort } from './ports.js';

/** What callers may pass: defaults (limit, offset, inStockOnly) are filled in. */
export type SearchQueryInput = z.input<typeof SearchQuery>;

/** Product search for the REST API and the agents. */
@Injectable()
export class SearchService {
  constructor(
    @Inject(SEARCH_PORT) private readonly port: SearchPort,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(DB) private readonly db: Executor,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Hindi words are searched as the catalog writes them; analytics keeps what the shopper typed. */
  async search(input: SearchQueryInput): Promise<SearchResult> {
    const query = parseOrThrow(SearchQuery, input, 'search query');
    const result = await this.port.search({ ...query, q: translateHindi(query.q) });
    await this.record(query, result.total);
    return result;
  }

  /** Analytics must never break search: failures are logged and swallowed. */
  private async record(query: SearchQuery, total: number): Promise<void> {
    // Browsing (no text) and later pages of the same search are not new searches.
    if (!query.q || query.offset > 0) return;
    try {
      await this.analytics.track(this.db, 'search', null, { q: query.q, total });
      if (total === 0) await this.analytics.track(this.db, 'zero_result_search', null, { q: query.q });
    } catch (err) {
      this.logger.warn({ err }, 'could not record search analytics');
    }
  }
}
