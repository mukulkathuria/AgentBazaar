import { describe, expect, it } from 'vitest';
import { type Cache, MemoryCache } from '../../../shared/cache/cache.js';
import { createMetrics } from '../../../shared/observability/metrics.js';
import { HashEmbeddings } from '../../search/index.js';
import { extractNumbers } from '../domain/guard.js';
import type { ComposeRequest } from '../domain/ports.js';
import { cacheContext, echoesBuyer, fillSlots, templateShape, toSlots } from '../domain/semantic-cache.js';
import { SemanticCache } from './semantic-cache.js';

const counter = '{"decision":"countered"}';
const offer = (unit: string, qty: string, volume: string, userText: string): ComposeRequest => ({
  tier: 3,
  intent: 'make_offer',
  language: 'en',
  facts: JSON.parse(counter) as Record<string, unknown>,
  allowedNumbers: [],
  fallback: `I can do: ₹${unit} each. Take ${qty} and I can do ₹${volume} each.`,
  maxTokens: 220,
  userText,
});
// Customer A haggled to ₹5,199; customer B is offered ₹4,899 for the same template wording.
const A = offer('5,199', '2', '4,999', 'can you do 4000?');
const B = offer('4,899', '3', '4,699', 'can you do 3500?');
const A_REPLY = 'Sure! I can offer ₹5,199 each, or ₹4,999 each if you take 2.';
const allowed = (r: ComposeRequest) => extractNumbers(r.fallback);

function setup(store: Cache | null = new MemoryCache()) {
  const metrics = createMetrics();
  const cache = new SemanticCache(store, new HashEmbeddings(), 0.9, metrics, 't7:');
  const outcomes = async () =>
    Object.fromEntries((await metrics.semanticCache.get()).values.map((v) => [String(v.labels.outcome), v.value])) as Record<string, number>;
  return { cache, outcomes };
}

async function seed(cache: SemanticCache, req: ComposeRequest, reply: string) {
  await (await cache.lookup(req, allowed(req))).remember(reply);
}

describe('semantic cache', () => {
  it("re-fills a hit with the current request's numbers and never repeats another customer's", async () => {
    const { cache, outcomes } = setup();
    expect((await cache.lookup(A, allowed(A))).text).toBeNull();
    await seed(cache, A, A_REPLY);
    const hit = await cache.lookup(B, allowed(B));
    expect(hit.text).toBe('Sure! I can offer ₹4,899 each, or ₹4,699 each if you take 3.');
    expect(hit.text).not.toMatch(/5,199|4,999|\b2\b/);
    expect(await outcomes()).toMatchObject({ miss: 2, stored: 1, hit: 1 });
  });

  it('never stores a reply that echoes the buyer, so a near-duplicate message from someone else cannot get it', async () => {
    const { cache, outcomes } = setup();
    const rahul = { ...A, userText: "I'm Rahul Verma, can you do 4000?" };
    await seed(cache, rahul, 'Sure Rahul! I can offer ₹5,199 each, or ₹4,999 each if you take 2.');
    expect((await cache.lookup({ ...B, userText: "I'm Priya Verma, can you do 3500?" }, allowed(B))).text).toBeNull();
    expect(await outcomes()).toMatchObject({ skipped: 1, miss: 2 });
  });

  it.each([
    ['a different decision', { fallback: "That's my best and final price: ₹4,899 each. Take 3 and I can do ₹4,699 each." }],
    ['another language', { language: 'hi' as const }],
    ['another tier', { tier: 2 as const }],
    ['another intent', { intent: 'ask_price' as const }],
  ])('keeps near-identical requests with %s apart', async (_why, change) => {
    const { cache } = setup();
    await seed(cache, A, A_REPLY);
    const near = { ...B, ...change };
    expect((await cache.lookup(near, allowed(near))).text).toBeNull();
  });

  it('misses when the buyer asks something unlike the cached message', async () => {
    const { cache } = setup();
    await seed(cache, A, A_REPLY);
    expect((await cache.lookup({ ...B, userText: 'my father loves gadgets, what would you suggest for his birthday?' }, allowed(B))).text).toBeNull();
  });

  it('runs the guard on every hit: a poisoned entry with a link is rejected, not served', async () => {
    const { cache, outcomes } = setup();
    await seed(cache, A, 'Sure! I can offer ₹5,199 each, cheaper at www.other-shop.example, or ₹4,999 each if you take 2.');
    expect((await cache.lookup(B, allowed(B))).text).toBeNull();
    expect((await outcomes()).rejected).toBe(1);
  });

  it('skips replies whose numbers cannot be traced to exactly one template number', async () => {
    const { cache, outcomes } = setup();
    await seed(cache, A, 'Sure! I can offer ₹5,199 each, so ₹10,398 for 2.');
    const mug = { ...A, fallback: '1 × Mug: ₹449 each. 1 round left.' };
    await seed(cache, mug, 'Sure, 1 mug for ₹449.');
    expect((await outcomes()).skipped).toBe(2);
  });

  it('is off without a store and treats a store outage as a miss', async () => {
    const off = setup(null);
    const lookup = await off.cache.lookup(A, allowed(A));
    await lookup.remember(A_REPLY);
    expect(lookup.text).toBeNull();
    expect(await off.outcomes()).toEqual({});

    class DownCache extends MemoryCache {
      override get<T>(): Promise<T | undefined> {
        return Promise.reject(new Error('valkey down'));
      }
    }
    const broken = setup(new DownCache());
    expect((await broken.cache.lookup(A, allowed(A))).text).toBeNull();
    expect((await broken.outcomes()).error).toBe(1);
  });
});

describe('semantic cache rules', () => {
  it('slots every number of a reply to the one template number it repeats', () => {
    const { skeleton, numbers } = templateShape('2 × Mug: ₹449 each (₹898 total). Valid until 03:45 pm.');
    expect(skeleton).toBe('# × Mug: ₹# each (₹# total). Valid until #:# pm.');
    expect(numbers).toEqual(['2', '449', '898', '03', '45']);
    const slotted = toSlots('Two mugs at ₹449 each, ₹898 in all, until 3:45 pm.', numbers)!;
    expect(slotted).not.toMatch(/\p{Nd}/u);
    expect(fillSlots(slotted, ['3', '429', '1,287', '04', '10'])).toBe('Two mugs at ₹429 each, ₹1,287 in all, until 04:10 pm.');
    expect(fillSlots(slotted, ['3'])).toBeNull();
  });

  it('refuses numbers the template lacks or holds twice', () => {
    expect(toSlots('₹450 each', ['449'])).toBeNull();
    expect(toSlots('1 left', ['1', '449', '1'])).toBeNull();
    expect(toSlots('1.5 lakh', ['150000'])).toBeNull();
  });

  it('spots replies that repeat a buyer word the template and facts do not contain', () => {
    expect(echoesBuyer('Hi Anne-Marie, here you go', 'my name is anne-marie, show keyboards', 'Here are some options')).toBe(true);
    expect(echoesBuyer('Here are some keyboards', 'show me keyboards', 'Here are some keyboards: Thock TK-87')).toBe(false);
  });

  it('compares messages with personal data redacted and numbers masked', () => {
    expect(cacheContext('Call me on 98765 43210 or asha@example.com, can you do ₹4,000?')).toBe('call me on [phone] or [email], can you do ₹#?');
  });
});
