// G5 semantic cache on the shared Valkey of tests/infra/docker-compose.yml. Keys carry a t7: prefix and a
// run id, and are deleted afterwards.
import { randomUUID } from 'node:crypto';
import { Valkey } from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SemanticCache } from '../../src/modules/agent/application/semantic-cache.js';
import { extractNumbers } from '../../src/modules/agent/domain/guard.js';
import type { ComposeRequest } from '../../src/modules/agent/domain/ports.js';
import { HashEmbeddings } from '../../src/modules/search/index.js';
import { ValkeyCache } from '../../src/shared/cache/valkey-cache.js';
import { createMetrics } from '../../src/shared/observability/metrics.js';

const prefix = `t7:${randomUUID().slice(0, 8)}:`;
const offer = (unit: string, qty: string, volume: string, userText: string): ComposeRequest => ({
  tier: 3,
  intent: 'make_offer',
  language: 'en',
  facts: { decision: 'countered' },
  allowedNumbers: [],
  fallback: `I can do: ₹${unit} each. Take ${qty} and I can do ₹${volume} each.`,
  maxTokens: 220,
  userText,
});
const A = offer('5,199', '2', '4,999', 'can you do 4000?');
const B = offer('4,899', '3', '4,699', 'can you do 3500?');
const allowed = (r: ComposeRequest) => extractNumbers(r.fallback);

describe('@growth semantic cache on real Valkey', () => {
  let client: Valkey;
  const node = () => new SemanticCache(new ValkeyCache(client), new HashEmbeddings(), 0.9, createMetrics(), prefix);
  const keys = () => client.keys(`${prefix}*`);

  beforeAll(async () => {
    client = new Valkey(process.env.VALKEY_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 2 });
    await client.connect();
  });
  afterAll(async () => {
    const left = await keys();
    if (left.length) await client.del(...left);
    await client.quit();
  });

  it("shares guarded wording between API instances with each request's own numbers, under a TTL, storing no price", async () => {
    await (await node().lookup(A, allowed(A))).remember('Sure! I can offer ₹5,199 each, or ₹4,999 each if you take 2.');
    const hit = await node().lookup(B, allowed(B));
    expect(hit.text).toBe('Sure! I can offer ₹4,899 each, or ₹4,699 each if you take 3.');

    const [key] = await keys();
    expect(await client.ttl(key!)).toBeGreaterThan(3500);
    const stored = JSON.parse((await client.get(key!))!) as { reply: { text: string } }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.reply.text).not.toMatch(/\p{Nd}/u);
  });

  it('never stores a reply that echoes the buyer, and rejects a poisoned entry when it is read', async () => {
    const echo = { ...A, fallback: 'I can do: ₹5,199 each.', userText: "I'm Rahul Verma, can you do 4000?" };
    await (await node().lookup(echo, allowed(echo))).remember('Sure Rahul! I can offer ₹5,199 each.');
    const priya = { ...echo, fallback: 'I can do: ₹4,899 each.', userText: "I'm Priya Verma, can you do 3500?" };
    expect((await node().lookup(priya, allowed(priya))).text).toBeNull();

    const link = { ...A, fallback: 'Final: ₹5,199 each.' };
    await (await node().lookup(link, allowed(link))).remember('Sure! ₹5,199 each, or see www.other-shop.example.');
    const next = { ...link, fallback: 'Final: ₹4,899 each.' };
    expect((await node().lookup(next, allowed(next))).text).toBeNull();
  });
});
