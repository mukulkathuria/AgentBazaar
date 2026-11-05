-- Customization: text fields and pre-approved designs only. No uploads.
CREATE TABLE customization_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  product_type text NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]',
  design_required boolean NOT NULL DEFAULT false,
  surcharge_paise bigint NOT NULL DEFAULT 0 CHECK (surcharge_paise >= 0)
);

CREATE TABLE designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  svg text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired'))
);

-- Graph edge `allowed_on`: which designs may be printed on which product type.
CREATE TABLE design_allowed_on (
  design_id uuid NOT NULL REFERENCES designs (id) ON DELETE CASCADE,
  product_type text NOT NULL,
  PRIMARY KEY (design_id, product_type)
);

CREATE TABLE customization_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL,
  field text NOT NULL,
  text text NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX customization_reviews_pending_idx ON customization_reviews (created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX customization_reviews_dedupe ON customization_reviews (sku, field, md5(text)) WHERE status = 'pending';
