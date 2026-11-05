-- Pricing policy engine: band policies, negotiations, offers, signed single-use quotes, approvals.
CREATE TABLE discount_policies (
  band text PRIMARY KEY CHECK (band IN ('fixed', 'standard', 'premium')),
  negotiable_bps int NOT NULL CHECK (negotiable_bps BETWEEN 0 AND 5000),
  volume_tiers jsonb NOT NULL DEFAULT '[]',
  max_rounds int NOT NULL CHECK (max_rounds BETWEEN 0 AND 10),
  approval_threshold_paise bigint CHECK (approval_threshold_paise >= 0),
  quote_ttl_seconds int NOT NULL CHECK (quote_ttl_seconds BETWEEN 60 AND 86400),
  concession_exponent real NOT NULL CHECK (concession_exponent BETWEEN 0.2 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO discount_policies (band, negotiable_bps, volume_tiers, max_rounds, approval_threshold_paise, quote_ttl_seconds, concession_exponent) VALUES
  ('fixed',    0,   '[{"minQty":10,"extraBps":500},{"minQty":50,"extraBps":1000}]', 0, NULL, 900, 2),
  ('standard', 800, '[{"minQty":3,"extraBps":200},{"minQty":5,"extraBps":400},{"minQty":10,"extraBps":700}]', 4, NULL, 900, 2),
  ('premium',  300, '[{"minQty":2,"extraBps":100},{"minQty":5,"extraBps":250}]', 3, 300000, 600, 2.5);

CREATE TABLE negotiation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL,
  sku text NOT NULL,
  product_name text NOT NULL,
  subject text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('mcp', 'a2a', 'chat', 'rest')),
  state text NOT NULL CHECK (state IN ('inquiry', 'quote', 'counter', 'pending_approval', 'accepted', 'rejected', 'expired', 'checkout')),
  band text NOT NULL,
  quantity int NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  list_unit_paise bigint NOT NULL,
  opening_unit_paise bigint NOT NULL,
  current_ask_paise bigint NOT NULL,
  round int NOT NULL DEFAULT 0,
  max_rounds int NOT NULL,
  customization jsonb,
  final_unit_paise bigint,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 0
);
CREATE INDEX negotiation_subject_idx ON negotiation_sessions (subject, created_at DESC);
CREATE INDEX negotiation_created_idx ON negotiation_sessions (created_at DESC);

CREATE TABLE offers (
  id bigserial PRIMARY KEY,
  negotiation_id uuid NOT NULL REFERENCES negotiation_sessions (id),
  actor text NOT NULL CHECK (actor IN ('buyer', 'seller')),
  unit_price_paise bigint NOT NULL,
  quantity int NOT NULL,
  decision text NOT NULL,
  reason_codes text[] NOT NULL DEFAULT '{}',
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offers_negotiation_idx ON offers (negotiation_id, id);
CREATE TRIGGER offers_append_only BEFORE UPDATE OR DELETE ON offers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negotiation_id uuid NOT NULL REFERENCES negotiation_sessions (id),
  variant_id uuid NOT NULL,
  sku text NOT NULL,
  subject text NOT NULL,
  quantity int NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
  list_unit_paise bigint NOT NULL,
  customization jsonb,
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'used', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quotes_one_active_per_negotiation ON quotes (negotiation_id) WHERE status = 'active';

CREATE TABLE pricing_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  negotiation_id uuid NOT NULL REFERENCES negotiation_sessions (id),
  requested_unit_paise bigint NOT NULL,
  quantity int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX pricing_approvals_one_pending ON pricing_approvals (negotiation_id) WHERE status = 'pending';
