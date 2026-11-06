import type { SearchQuery, SearchResult } from '@agentbazaar/contracts';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Executor } from '../../../shared/db/database.js';
import type { AnalyticsService } from '../../analytics/index.js';
import type { SearchPort } from './ports.js';
import { SearchService } from './search.service.js';

const db = {} as Executor;

function setup(total: number, track: AnalyticsService['track'] = vi.fn(async () => undefined)) {
  const result: SearchResult = { items: [], total, facets: { brands: [], categories: [] }, tookMs: 1 };
  const port = { search: vi.fn(async (_q: SearchQuery) => result) } as unknown as SearchPort & { search: ReturnType<typeof vi.fn> };
  const analytics = { track } as unknown as AnalyticsService;
  const logger = { warn: vi.fn() } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
  return { service: new SearchService(port, analytics, db, logger), port, track, logger };
}

describe('@lite search service', () => {
  it('fills contract defaults and logs searches, plus zero-result searches', async () => {
    const { service, port, track } = setup(0);
    await service.search({ q: '  keybaord  ' });
    expect(port.search).toHaveBeenCalledWith({ q: 'keybaord', inStockOnly: false, limit: 12, offset: 0 });
    expect(vi.mocked(track).mock.calls).toEqual([
      [db, 'search', null, { q: 'keybaord', total: 0 }],
      [db, 'zero_result_search', null, { q: 'keybaord' }],
    ]);
  });

  it('does not count browsing or later pages as searches', async () => {
    const { service, track } = setup(0);
    await service.search({ q: '', category: 'food' });
    await service.search({ q: 'tea', offset: 12 });
    expect(track).not.toHaveBeenCalled();
  });

  it('still answers when analytics fails', async () => {
    const { service, logger } = setup(3, vi.fn(async () => Promise.reject(new Error('db down'))));
    await expect(service.search({ q: 'tea' })).resolves.toMatchObject({ total: 3 });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('rejects queries outside the contract', async () => {
    const { service, port } = setup(0);
    await expect(service.search({ q: 'tea', limit: 500 })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(port.search).not.toHaveBeenCalled();
  });
});
