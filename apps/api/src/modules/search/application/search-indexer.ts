import { Inject, Injectable } from '@nestjs/common';
import type { Executor } from '../../../shared/db/database.js';
import type { OutboxEvent, Subscription } from '../../../shared/outbox/outbox.js';
import { CatalogService } from '../../catalog/index.js';
import type { EmbeddingsPort } from '../domain/embeddings.js';
import { documentText, EMBEDDINGS, SEARCH_PORT, type SearchPort } from './ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

/** Keeps the search read model in step with the catalog and stock, from the outbox. */
@Injectable()
export class SearchIndexer {
  constructor(
    @Inject(SEARCH_PORT) private readonly port: SearchPort,
    @Inject(EMBEDDINGS) private readonly embeddings: EmbeddingsPort,
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  subscription(): Subscription {
    return {
      consumer: 'search-indexer',
      topics: ['catalog.product_upserted', 'inventory.stock_changed'],
      handler: (event, tx) => this.onEvent(event, tx),
    };
  }

  async onEvent(event: OutboxEvent, tx: Executor): Promise<void> {
    const productId =
      event.topic === 'inventory.stock_changed'
        ? await this.productOfVariant(event.payload.variantId, tx)
        : uuidOrNull(event.payload.productId);
    if (productId) await this.indexProduct(productId, tx);
  }

  /** Upserts one product, or removes it when it is no longer active. Returns whether it is indexed. */
  async indexProduct(productId: string, ex?: Executor): Promise<boolean> {
    const doc = await this.catalog.searchSource(productId, ex);
    if (!doc) {
      await this.port.remove(productId, ex);
      return false;
    }
    await this.port.upsert([doc], await this.embeddings.embed([documentText(doc)]), ex);
    return true;
  }

  /**
   * Rebuilds the whole index page by page (used by `cli reindex`): three catalog queries and one
   * engine write per page, so memory stays bounded at any catalog size. Returns the documents written.
   */
  async reindexAll(pageSize = 500, onProgress?: (indexed: number) => void): Promise<number> {
    let indexed = 0;
    for (let after: string | null = null; ; ) {
      const ids = await this.catalog.productIdsPage(after, pageSize);
      if (!ids.length) return indexed;
      const docs = await this.catalog.searchSources(ids);
      await this.port.upsert(docs, await this.embeddings.embed(docs.map(documentText)));
      indexed += docs.length;
      onProgress?.(indexed);
      after = ids[ids.length - 1]!;
    }
  }

  private async productOfVariant(variantId: unknown, tx: Executor): Promise<string | null> {
    const id = uuidOrNull(variantId);
    return id ? this.catalog.productIdForVariant(id, tx) : null;
  }
}
