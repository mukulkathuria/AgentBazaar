import { describe, expect, it } from 'vitest';
import { AI_CRAWLERS } from '../geo/detect';
import { buildRobots, policyFromEnv, PRIVATE_PATHS } from './robots';

type Rule = { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] };
const rulesOf = (r: ReturnType<typeof buildRobots>) => (Array.isArray(r.rules) ? r.rules : [r.rules]) as Rule[];

describe('robots policy builder', () => {
  it('allows every known AI crawler by default but never the private paths', () => {
    const robots = buildRobots(policyFromEnv({}), 'https://shop.example');
    const rules = rulesOf(robots);
    expect(rules[0]).toEqual({ userAgent: '*', allow: '/', disallow: PRIVATE_PATHS });
    expect(rules[1]?.userAgent).toEqual([...AI_CRAWLERS]);
    expect(rules[1]?.disallow).toEqual(PRIVATE_PATHS);
    expect(rules).toHaveLength(2);
    expect(robots.sitemap).toBe('https://shop.example/sitemap.xml');
    for (const path of ['/checkout', '/account', '/admin', '/pay', '/api']) expect(PRIVATE_PATHS).toContain(path);
  });

  it('blocks disallowed crawlers entirely; disallow wins over allow', () => {
    const policy = policyFromEnv({ AI_CRAWLERS_ALLOW: 'GPTBot, ClaudeBot', AI_CRAWLERS_DISALLOW: 'gptbot,CCBot' });
    const rules = rulesOf(buildRobots(policy, 'https://shop.example'));
    expect(rules[1]).toEqual({ userAgent: ['ClaudeBot'], allow: '/', disallow: PRIVATE_PATHS });
    expect(rules[2]).toEqual({ userAgent: ['gptbot', 'CCBot'], disallow: '/' });
  });

  it('an empty allow list leaves AI crawlers under the default rule', () => {
    const rules = rulesOf(buildRobots(policyFromEnv({ AI_CRAWLERS_ALLOW: '' }), 'https://shop.example'));
    expect(rules).toEqual([{ userAgent: '*', allow: '/', disallow: PRIVATE_PATHS }]);
  });
});
