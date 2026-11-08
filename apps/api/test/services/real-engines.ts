import { randomUUID } from 'node:crypto';
import type { EmbeddingsPort } from '../../src/modules/search/domain/embeddings.js';
import type { JsonHttpOptions } from '../../src/modules/search/infrastructure/json-http.js';
import { MeilisearchAdapter } from '../../src/modules/search/infrastructure/meilisearch.adapter.js';
import { OpenSearchAdapter } from '../../src/modules/search/infrastructure/opensearch.adapter.js';

const env = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set; see tests/infra/services.env`);
  return value;
};

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok && res.status !== 404) throw new Error(`${init.method ?? 'GET'} ${url} answered HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export type RealEngines = ReturnType<typeof realEngines>;

/**
 * The growth and scale adapters on a Meilisearch index, an OpenSearch index and a Qdrant collection
 * of their own (`t4_<prefix>_<random>`), with the production timeouts, plus what tests need around them.
 */
export function realEngines(prefix: string, embeddings: EmbeddingsPort) {
  const name = `t4_${prefix}_${randomUUID().slice(0, 8)}`;
  const [meili, key, os, qdrant] = ['MEILISEARCH_URL', 'MEILISEARCH_API_KEY', 'OPENSEARCH_URL', 'QDRANT_URL'].map(env) as [
    string,
    string,
    string,
    string,
  ];
  const meiliInit = (method = 'GET'): RequestInit => ({ method, headers: { authorization: `Bearer ${key}` } });
  const tasks = (statuses: string) =>
    call<{ total: number; results: { error: { message: string } | null }[] }>(
      `${meili}/tasks?indexUids=${name}&statuses=${statuses}&limit=1`,
      meiliInit(),
    );
  return {
    name,
    meilisearch: new MeilisearchAdapter({ url: meili, apiKey: key, index: name }, embeddings),
    /** Another adapter on the same Meilisearch index, for example with a recording fetch. */
    meilisearchWith: (opts: JsonHttpOptions) => new MeilisearchAdapter({ url: meili, apiKey: key, index: name, ...opts }, embeddings),
    opensearch: new OpenSearchAdapter({ url: os, qdrantUrl: qdrant, index: name, collection: name }, embeddings),

    /** Waits until Meilisearch has applied every queued write (none may fail) and OpenSearch has refreshed. */
    async settle(timeoutMs = 600_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while ((await tasks('enqueued,processing')).total > 0) {
        if (Date.now() > deadline) throw new Error(`Meilisearch index ${name} still busy after ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const failed = await tasks('failed');
      if (failed.total > 0) throw new Error(`Meilisearch task failed: ${failed.results[0]?.error?.message}`);
      await call(`${os}/${name}/_refresh`, { method: 'POST' });
    },

    async drop(): Promise<void> {
      await Promise.allSettled([
        call(`${meili}/indexes/${name}`, meiliInit('DELETE')),
        call(`${os}/${name}`, { method: 'DELETE' }),
        call(`${qdrant}/collections/${name}`, { method: 'DELETE' }),
      ]);
    },
  };
}
