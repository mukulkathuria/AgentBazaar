-- Search read model, fed from the outbox. Rebuilt by `cli reindex`; other profiles index elsewhere.
CREATE TABLE search_documents (
  product_id uuid PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  brand text NOT NULL,
  category_path ltree NOT NULL,
  category_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sku_text text NOT NULL DEFAULT '',
  default_sku text NOT NULL,
  band text NOT NULL,
  min_price_paise bigint NOT NULL,
  max_price_paise bigint NOT NULL,
  in_stock boolean NOT NULL,
  image text,
  customizable boolean NOT NULL DEFAULT false,
  popularity real NOT NULL DEFAULT 0,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', name), 'A') ||
    setweight(to_tsvector('simple', brand), 'A') ||
    setweight(to_tsvector('english', name), 'B') ||
    setweight(to_tsvector('simple', sku_text), 'B') ||
    setweight(to_tsvector('simple', category_name), 'B') ||
    setweight(to_tsvector('english', description), 'C')
  ) STORED,
  trgm_text text GENERATED ALWAYS AS (lower(name || ' ' || brand)) STORED,
  embedding vector(256),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_tsv_gin ON search_documents USING gin (tsv);
CREATE INDEX search_trgm_gin ON search_documents USING gin (trgm_text gin_trgm_ops);
CREATE INDEX search_category_gist ON search_documents USING gist (category_path);
CREATE INDEX search_price_idx ON search_documents (min_price_paise);
CREATE INDEX search_embedding_hnsw ON search_documents USING hnsw (embedding vector_cosine_ops);
