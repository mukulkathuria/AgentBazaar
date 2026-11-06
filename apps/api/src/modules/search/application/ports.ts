import type { SearchQuery, SearchResult } from '@agentbazaar/contracts';
import type { Executor } from '../../../shared/db/database.js';
import type { SearchSource } from '../../catalog/index.js';

/** A product as search engines see it: exactly what the catalog exposes for search. */
export type SearchDocument = SearchSource;

/**
 * Search engine port. Postgres (lite), Meilisearch (growth) or OpenSearch + Qdrant (scale),
 * chosen by `config.adapters.search`.
 */
export interface SearchPort {
  /**
   * Writes documents with their vectors (same order) in one engine request; callers keep batches to
   * a page (at most 1,000). `ex` lets the Postgres adapter write inside the caller's transaction;
   * HTTP engines ignore it.
   */
  upsert(docs: readonly SearchDocument[], embeddings: readonly (readonly number[])[], ex?: Executor): Promise<void>;
  remove(productId: string, ex?: Executor): Promise<void>;
  search(query: SearchQuery): Promise<SearchResult>;
  count(): Promise<number>;
}

export const SEARCH_PORT = Symbol('SEARCH_PORT');
export const EMBEDDINGS = Symbol('EMBEDDINGS');

/** The text the vector leg embeds for a document. */
export const documentText = (d: SearchDocument): string => [d.name, d.brand, d.categoryName, d.description].join(' ');
