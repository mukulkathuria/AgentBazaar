import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/env';
import { buildRobots, policyFromEnv } from '@/lib/seo/robots';

// Read AI_CRAWLERS_ALLOW / AI_CRAWLERS_DISALLOW at request time so operators can change them without a rebuild.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return buildRobots(policyFromEnv(), SITE_URL);
}
