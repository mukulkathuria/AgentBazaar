import type { MetadataRoute } from 'next';
import { AI_CRAWLERS } from '../geo/detect';

/** Never crawlable, whatever the AI crawler policy says. */
export const PRIVATE_PATHS = ['/checkout', '/account', '/admin', '/pay', '/api', '/cart', '/orders'];

export interface CrawlerPolicy {
  allow: string[];
  disallow: string[];
}

export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** AI_CRAWLERS_ALLOW defaults to every known AI crawler (a GEO-first store); AI_CRAWLERS_DISALLOW wins. */
export function policyFromEnv(env: Record<string, string | undefined> = process.env): CrawlerPolicy {
  return {
    allow: env.AI_CRAWLERS_ALLOW === undefined ? [...AI_CRAWLERS] : parseList(env.AI_CRAWLERS_ALLOW),
    disallow: parseList(env.AI_CRAWLERS_DISALLOW),
  };
}

export function buildRobots(policy: CrawlerPolicy, siteUrl: string): MetadataRoute.Robots {
  const blocked = new Set(policy.disallow.map((b) => b.toLowerCase()));
  const allowed = policy.allow.filter((b) => !blocked.has(b.toLowerCase()));
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: PRIVATE_PATHS },
      ...(allowed.length ? [{ userAgent: allowed, allow: '/', disallow: PRIVATE_PATHS }] : []),
      ...(policy.disallow.length ? [{ userAgent: policy.disallow, disallow: '/' }] : []),
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
