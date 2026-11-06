import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import type { AppConfig } from '@agentbazaar/config';
import { TrackEventInput } from '@agentbazaar/contracts';
import { safeEqual, sha256Hex } from '../../../shared/crypto/primitives.js';
import { Auth } from '../../../shared/http/auth.js';
import { parseOrThrow } from '../../../shared/http/zod.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { CONFIG } from '../../../shared/kernel/tokens.js';
import { AnalyticsService } from '../application/analytics.service.js';

/** Hashing first makes the comparison constant-time regardless of the key's length. */
export const ingestKeyMatches = (given: string | undefined, expected: string): boolean =>
  given !== undefined && safeEqual(sha256Hex(given), sha256Hex(expected));

@Controller()
export class AnalyticsController {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('api/v1/analytics/events')
  @HttpCode(202)
  @Auth('public')
  async track(@Body() body: unknown, @Headers('x-ingest-key') key: string | undefined) {
    const expected = this.config.env.ANALYTICS_INGEST_KEY;
    // Checked before the body, so callers without the key learn nothing about the schema.
    if (expected && !ingestKeyMatches(key, expected)) throw new AppError('unauthorized', 'Missing or invalid ingest key');
    await this.analytics.ingest(parseOrThrow(TrackEventInput, body ?? {}, 'event'));
    return { ok: true as const };
  }
}
