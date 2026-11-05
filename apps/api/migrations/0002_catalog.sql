-- Catalog: products own shared info, variants own price. Cost and margin columns never leave the API.
CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE
);

CREATE TABLE attribute_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  definition jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path ltree NOT NULL UNIQUE,
  name text NOT NULL,
  name_hi text,
  attribute_schema_id uuid REFERENCES attribute_schemas (id)
);
CREATE INDEX categories_path_gist ON categories USING gist (path);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  brand_id uuid NOT NULL REFERENCES brands (id),
  category_id uuid NOT NULL REFERENCES categories (id),
  description text NOT NULL DEFAULT '',
  band text NOT NULL CHECK (band IN ('fixed', 'standard', 'premium')),
  hsn_code text NOT NULL CHECK (hsn_code ~ '^[0-9]{4,8}$'),
  product_type text NOT NULL DEFAULT 'general',
  attributes jsonb NOT NULL DEFAULT '{}',
  images jsonb NOT NULL DEFAULT '[]',
  faqs jsonb NOT NULL DEFAULT '[]',
  return_window_days int NOT NULL DEFAULT 7 CHECK (return_window_days BETWEEN 0 AND 90),
  customization_schema_id uuid,
  rating_avg real CHECK (rating_avg BETWEEN 0 AND 5),
  rating_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_brand_idx ON products (brand_id);

CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku text NOT NULL UNIQUE CONSTRAINT variants_sku_format CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{1,63}$'),
  title text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',
  price_paise bigint NOT NULL CHECK (price_paise > 0),
  -- Legal Metrology: never sell above MRP.
  mrp_paise bigint NOT NULL CONSTRAINT variants_price_within_mrp CHECK (mrp_paise >= price_paise),
  cost_price_paise bigint NOT NULL CHECK (cost_price_paise >= 0),
  -- Landed-cost components in paise: freight, non_recoverable_tax, payment_fee, expected_return_cost.
  landed_cost jsonb NOT NULL DEFAULT '{}',
  min_margin_bps int NOT NULL DEFAULT 1000 CHECK (min_margin_bps BETWEEN 0 AND 10000),
  supplier text,
  lead_time_days int CHECK (lead_time_days >= 0),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX variants_product_idx ON variants (product_id, position);

-- Collected from day one for the ops-intelligence agents (Phase 4).
CREATE TABLE price_history (
  id bigserial PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES variants (id) ON DELETE CASCADE,
  price_paise bigint NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_variant_idx ON price_history (variant_id, changed_at);

CREATE TABLE competitor_snapshots (
  id bigserial PRIMARY KEY,
  variant_id uuid REFERENCES variants (id) ON DELETE SET NULL,
  source text NOT NULL,
  price_paise bigint,
  observed_at timestamptz NOT NULL,
  extracted jsonb NOT NULL DEFAULT '{}'
);
