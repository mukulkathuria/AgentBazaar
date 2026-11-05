-- GST: rates per HSN code with effective dates; invoices numbered consecutively per financial year.
-- Seeded rates are illustrative. Operators must confirm current rates with their tax adviser.
CREATE TABLE gst_rates (
  hsn_code text NOT NULL CHECK (hsn_code ~ '^[0-9]{4,8}$'),
  rate_bps int NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  effective_from date NOT NULL,
  description text NOT NULL DEFAULT '',
  PRIMARY KEY (hsn_code, effective_from)
);

CREATE TABLE invoice_counters (
  financial_year text PRIMARY KEY,
  last_number int NOT NULL
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE,
  number text NOT NULL UNIQUE,
  financial_year text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  seller jsonb NOT NULL,
  place_of_supply text NOT NULL,
  lines jsonb NOT NULL,
  totals jsonb NOT NULL
);
