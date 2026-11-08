import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../shared/db/database.js';
import type { OutboxEvent } from '../../../shared/outbox/outbox.js';
import { AnalyticsService } from './analytics.service.js';
import type { AnalyticsRecord, AnalyticsStore } from './ports.js';

const tx = {} as Executor;

function service() {
  const recorded: AnalyticsRecord[] = [];
  const store: AnalyticsStore = {
    record: async (_ex, event) => void recorded.push(event),
    geo: async () => ({ crawlerHits: { GPTBot: 2 }, aiReferrals: {} }),
    search: async () => ({ searches: 3, zeroResults: 1, topZeroResultQueries: [{ query: 'tea', count: 1 }] }),
  };
  return { svc: new AnalyticsService(tx, store), recorded };
}

const closed = (payload: Record<string, unknown>): OutboxEvent => ({
  id: 'e1',
  topic: 'negotiation.closed',
  aggregateId: 'neg-from-aggregate',
  payload,
  createdAt: new Date('2026-11-05T10:00:00Z'),
});

describe('@lite analytics events', () => {
  it('redacts and caps the reference, keeps null, and sanitizes the data', async () => {
    const { svc, recorded } = service();
    await svc.track(tx, 'page_view', `/p/${'x'.repeat(300)}`, { q: 'mail me at asha@example.com', nested: { no: 1 } });
    await svc.track(tx, 'ping', null);
    expect(recorded[0]!.ref).toHaveLength(200);
    expect(recorded[0]!.data).toEqual({ q: 'mail me at [EMAIL]' });
    expect(recorded[1]).toEqual({ kind: 'ping', ref: null, data: {} });
    await svc.track(tx, 'page_view', 'call 9876543210');
    expect(recorded[2]!.ref).toBe('call [PHONE]');
  });

  it('records page views from the web server without query strings, and the agent when there is one', async () => {
    const { svc, recorded } = service();
    await svc.ingest({ kind: 'crawler_hit', path: '/p/keyboard?t=secret#x', agent: 'GPTBot' });
    await svc.ingest({ kind: 'page_view', path: '/c/keyboards' });
    expect(recorded).toEqual([
      { kind: 'crawler_hit', ref: '/p/keyboard', data: { agent: 'GPTBot' } },
      { kind: 'page_view', ref: '/c/keyboards', data: {} },
    ]);
  });

  it('serves the dashboards from the store', async () => {
    const { svc } = service();
    expect(await svc.dashboardGeo()).toEqual({ crawlerHits: { GPTBot: 2 }, aiReferrals: {} });
    expect((await svc.searchStats()).zeroResults).toBe(1);
  });

  it('turns closed negotiations into outcome events that never name the parties', async () => {
    const { svc, recorded } = service();
    const sub = svc.negotiationSubscription();
    expect(sub).toMatchObject({ consumer: 'analytics-negotiations', topics: ['negotiation.closed'] });
    await sub.handler(closed({ negotiationId: 'neg-1', outcome: 'accepted', band: 'standard', discountBps: 450, subject: 'customer:abc' }), tx);
    await sub.handler(closed({ outcome: 'rejected', band: 'premium', discountBps: 0 }), tx);
    expect(recorded).toEqual([
      { kind: 'negotiation_outcome', ref: 'neg-1', data: { outcome: 'accepted', band: 'standard', discountBps: 450 } },
      { kind: 'negotiation_outcome', ref: 'neg-from-aggregate', data: { outcome: 'rejected', band: 'premium', discountBps: 0 } },
    ]);
  });
});
