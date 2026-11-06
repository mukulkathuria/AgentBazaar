export { SearchModule } from './search.module.js';
export { SearchService, type SearchQueryInput } from './application/search.service.js';
export { SearchIndexer } from './application/search-indexer.js';
export { EMBEDDINGS, SEARCH_PORT, type SearchDocument, type SearchPort } from './application/ports.js';
export { HashEmbeddings, type EmbeddingsPort } from './domain/embeddings.js';
